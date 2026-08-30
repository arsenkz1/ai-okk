import "dotenv/config";
import { prisma } from "../config/database";
import {
  alreadyGoneAdditions,
  createAmoFieldOptionRegistry,
  planOptionRollback,
  type SnapshotEnum,
} from "../services/amoFieldOptionRegistry";
import { createCallStageAmoClient } from "../services/callStageAmoClient";

/**
 * Removes the option-list entries this system added to amoCRM select fields.
 *
 * It deliberately does NOT restore the stored snapshot wholesale: options that
 * people added by hand after the snapshot would be destroyed by that. Only the
 * options recorded in the addition log are removed, and the original list stays
 * available in AmoFieldOptionSnapshot if a full manual restore is ever wanted.
 *
 *   AMO_FIELD_OPTION_ROLLBACK_CONFIRM=remove_ai_added_options \
 *     node dist/scripts/rollbackAmoFieldOptions.js [fieldId]
 *
 * Without the confirmation it runs as a dry run and only prints the plan.
 */

const CONFIRMATION = "remove_ai_added_options";

function parseFieldIdArgument(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("field id argument must be a positive integer");
  return parsed;
}

async function main(): Promise<void> {
  const confirmed = process.env.AMO_FIELD_OPTION_ROLLBACK_CONFIRM?.trim() === CONFIRMATION;
  const fieldIdFilter = parseFieldIdArgument(process.argv[2]);

  const baseUrl = process.env.AMOCRM_BASE_URL?.trim();
  const accessToken = process.env.AMOCRM_ACCESS_TOKEN?.trim();
  if (!baseUrl || !accessToken) throw new Error("AMOCRM_BASE_URL and AMOCRM_ACCESS_TOKEN are required");

  const registry = createAmoFieldOptionRegistry();
  const amo = createCallStageAmoClient({ baseUrl, accessToken });
  const additions = await registry.listActiveAdditions(fieldIdFilter);

  if (additions.length === 0) {
    console.log("[OptionRollback] no AI-added options are recorded; nothing to do");
    return;
  }

  const byField = new Map<number, typeof additions>();
  for (const addition of additions) {
    byField.set(addition.fieldId, [...(byField.get(addition.fieldId) ?? []), addition]);
  }

  for (const [fieldId, fieldAdditions] of byField) {
    const snapshot = await registry.getSnapshot(fieldId);
    const fieldName = fieldAdditions[0].fieldName;
    console.log(`\n[OptionRollback] field ${fieldId} (${fieldName})`);
    console.log(
      snapshot
        ? `  original options (${snapshot.originalEnums.length}): ${snapshot.originalEnums.map((item) => item.value).join(" | ")}`
        : "  ⚠️ no original snapshot stored for this field",
    );

    const current = await amo.getFieldOptions(fieldId);
    const currentEnums: SnapshotEnum[] = current.map((item) => ({ id: item.id, value: item.value, sort: item.sort }));
    const { keptEnums, removed } = planOptionRollback({ currentEnums, additions: fieldAdditions });
    const gone = alreadyGoneAdditions({ currentEnums, additions: fieldAdditions });

    console.log(`  to remove (${removed.length}): ${removed.map((item) => item.value).join(" | ") || "—"}`);
    console.log(`  keeping (${keptEnums.length}): ${keptEnums.map((item) => item.value).join(" | ") || "—"}`);
    if (gone.length > 0) {
      console.log(`  already absent in amoCRM (${gone.length}): ${gone.map((item) => item.value).join(" | ")}`);
    }

    if (!confirmed) {
      console.log(`  dry run — set AMO_FIELD_OPTION_ROLLBACK_CONFIRM=${CONFIRMATION} to apply`);
      continue;
    }

    if (removed.length > 0) {
      const outcome = await amo.replaceFieldOptions({ fieldId, enums: keptEnums });
      if (outcome.kind !== "confirmed") {
        console.error(`  ❌ amoCRM did not apply the rollback: ${outcome.kind}`);
        continue;
      }
      await registry.markReverted(removed.map((item) => item.id));
      console.log(`  ✅ removed ${removed.length} option(s)`);
    }
    // Entries amoCRM no longer has are closed out too: there is nothing left
    // to remove, and leaving them open would repeat this work forever.
    if (gone.length > 0) await registry.markReverted(gone.map((item) => item.id));
  }
}

main()
  .catch((error: unknown) => {
    console.error("[OptionRollback] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
