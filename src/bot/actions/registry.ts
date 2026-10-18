import type { Access, BotRole } from "../access";
import { hasRole } from "../access";
import type { ActionDefinition, SectionId } from "./types";

/**
 * The single list of what the bot can do. Menus, `/help` and command
 * registration all read from here.
 */

export interface SectionDefinition {
  id: SectionId;
  label: string;
  /** Roles that see the section; empty means every linked user. */
  roles: BotRole[];
}

const SECTION_LIST: SectionDefinition[] = [
  { id: "reports", label: "Hisobotlar", roles: ["admin", "manager"] },
  { id: "ai", label: "AI-murabbiy", roles: ["manager"] },
  { id: "team", label: "Jamoa", roles: ["teamlead"] },
  { id: "company", label: "Kompaniya", roles: ["admin", "rop"] },
  { id: "phoenix", label: "Feniks", roles: ["admin", "rop"] },
  { id: "users", label: "Foydalanuvchilar", roles: ["admin"] },
  { id: "sync", label: "Sinxronizatsiya", roles: ["admin"] },
  { id: "help", label: "Yordam", roles: [] },
];

export const SECTIONS: readonly SectionDefinition[] = Object.freeze(SECTION_LIST.map((section) => Object.freeze(section)));

/** Reserved button: drops a pending input or the date dialog. */
export const CANCEL_LABEL = "Bekor qilish";

const actions = new Map<string, ActionDefinition>();

export function defineAction(definition: ActionDefinition): ActionDefinition {
  if (actions.has(definition.id)) throw new Error(`bot action "${definition.id}" is defined twice`);
  actions.set(definition.id, definition);
  return definition;
}

export function getAction(id: string): ActionDefinition {
  const action = actions.get(id);
  if (!action) throw new Error(`bot action "${id}" is not defined`);
  return action;
}

export function allActions(): ActionDefinition[] {
  return [...actions.values()];
}

export function commandActions(): ActionDefinition[] {
  return allActions().filter((action) => action.command !== undefined);
}

export function isAllowed(action: ActionDefinition, access: Access): boolean {
  return action.roles.length === 0 || hasRole(access, ...action.roles);
}

/** Actions a user may see on a keyboard, optionally within one section. */
export function visibleActions(access: Access, section?: SectionId): ActionDefinition[] {
  return allActions().filter((action) => (
    !action.commandOnly
    && (section === undefined || action.section === section)
    && isAllowed(action, access)
  ));
}
