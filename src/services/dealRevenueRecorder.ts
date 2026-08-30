import { prisma } from "../config/database";
import {
  resolvePaymentAmountFieldId,
  resolveRevenueAmount,
  revenueKindForStage,
  type AmoRevenueLead,
  type RevenueKind,
} from "./salesRevenuePolicy";

/**
 * Records a deal entering a revenue-bearing stage.
 *
 * The webhook payload alone is not trusted for money: the lead is re-read from
 * amoCRM so the budget, the payment field and the current owner all come from
 * one consistent snapshot. The (dealId, statusId) unique key makes a replayed
 * webhook a no-op instead of double revenue.
 */

export interface RevenueLeadRead extends AmoRevenueLead {
  id?: unknown;
  pipeline_id?: unknown;
  status_id?: unknown;
  responsible_user_id?: unknown;
}

export type RecordRevenueResult =
  | { kind: "not_revenue" }
  | { kind: "lead_unavailable" }
  | { kind: "stage_changed" }
  | { kind: "duplicate" }
  | { kind: "recorded"; revenueKind: RevenueKind; amount: number | null; managerId: number | null };

export interface RecordDealRevenueDependencies {
  readLead(dealId: number): Promise<RevenueLeadRead | null>;
  now?: () => Date;
  paymentAmountFieldId?: number | null;
}

async function resolveManagerId(amoUserId: number | null): Promise<number | null> {
  if (amoUserId === null) return null;
  const manager = await prisma.manager.findUnique({ where: { amoUserId }, select: { id: true } });
  return manager?.id ?? null;
}

export async function recordDealRevenue(
  dealId: number,
  pipelineId: number,
  statusId: number,
  dependencies: RecordDealRevenueDependencies,
): Promise<RecordRevenueResult> {
  const kind = revenueKindForStage(pipelineId, statusId);
  if (kind === null) return { kind: "not_revenue" };

  const lead = await dependencies.readLead(dealId);
  if (!lead) return { kind: "lead_unavailable" };

  // The deal may have moved on between the webhook and this read; recording the
  // stage it is no longer in would attribute revenue to a stale transition.
  const freshStatusId = Number(lead.status_id);
  const freshPipelineId = Number(lead.pipeline_id);
  if (freshStatusId !== statusId || freshPipelineId !== pipelineId) return { kind: "stage_changed" };

  const paymentAmountFieldId = dependencies.paymentAmountFieldId !== undefined
    ? dependencies.paymentAmountFieldId
    : resolvePaymentAmountFieldId();
  const amount = resolveRevenueAmount(kind, lead, paymentAmountFieldId);
  const amoUserId = Number.isInteger(Number(lead.responsible_user_id))
    ? Number(lead.responsible_user_id)
    : null;
  const managerId = await resolveManagerId(amoUserId);
  const occurredAt = (dependencies.now ?? (() => new Date()))();

  // The deal row must exist before an event can reference it.
  await prisma.deal.upsert({
    where: { id: dealId },
    update: {
      pipelineId,
      statusId,
      ...(amount !== null && kind === "won" ? { price: amount } : {}),
      ...(amoUserId !== null ? { responsibleUserId: amoUserId } : {}),
    },
    create: {
      id: dealId,
      pipelineId,
      statusId,
      ...(amount !== null && kind === "won" ? { price: amount } : {}),
      ...(amoUserId !== null ? { responsibleUserId: amoUserId } : {}),
    },
  });

  const existing = await prisma.dealPaymentEvent.findUnique({
    where: { dealId_statusId: { dealId, statusId } },
    select: { id: true },
  });
  if (existing) return { kind: "duplicate" };

  try {
    await prisma.dealPaymentEvent.create({
      data: { dealId, pipelineId, statusId, kind, amount, managerId, amoUserId, occurredAt },
    });
  } catch (error) {
    // A concurrent webhook delivery won the unique key; that is the intended
    // outcome, not a failure.
    const existsNow = await prisma.dealPaymentEvent.findUnique({
      where: { dealId_statusId: { dealId, statusId } },
      select: { id: true },
    });
    if (existsNow) return { kind: "duplicate" };
    throw error;
  }

  return { kind: "recorded", revenueKind: kind, amount, managerId };
}
