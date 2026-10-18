import { prisma } from "../config/database";

/**
 * Who a Telegram account is, for the purpose of bot permissions.
 *
 * Until now every handler file carried its own copy of "is this an admin" and
 * its own way of finding the linked manager, and they disagreed on inactive
 * accounts. Keyboards will build menus from roles, so there must be exactly
 * one answer. This is it.
 */

export type BotRole = "admin" | "rop" | "teamlead" | "manager";

/** Manager behind a used Telegram link, with its team. */
export async function findLinkedManager(telegramUserId: string) {
  const link = await prisma.telegramLink.findFirst({
    where: { telegramUserId, status: "used" },
    include: { manager: { include: { team: true } } },
  });
  return link?.manager ?? null;
}

export type LinkedManager = NonNullable<Awaited<ReturnType<typeof findLinkedManager>>>;

export interface Access {
  telegramUserId: string;
  /** `ADMIN_TELEGRAM_ID` or a `BotAdmin` row. Independent of any manager link. */
  isAdmin: boolean;
  /** Linked manager, active or not; null when the account is not linked. */
  manager: LinkedManager | null;
  /**
   * Roles that grant access right now. `admin` needs no link. Every active
   * linked manager has `manager`; team leads and ROPs additionally have their
   * own role. An inactive manager has no manager roles at all.
   */
  roles: ReadonlySet<BotRole>;
}

export async function isBotAdmin(telegramUserId: string): Promise<boolean> {
  if (telegramUserId === process.env.ADMIN_TELEGRAM_ID) return true;
  return (await prisma.botAdmin.findUnique({ where: { telegramUserId } })) !== null;
}

const LINKED_ROLE: Record<string, BotRole> = { ROP: "rop", TEAMLEAD: "teamlead", MANAGER: "manager" };

/** The manager's own role, regardless of whether the account is active. */
export function isLinkedAs(manager: { role: string }, role: BotRole): boolean {
  return LINKED_ROLE[manager.role] === role;
}

export function rolesOf(isAdmin: boolean, manager: { role: string; isActive: boolean } | null): Set<BotRole> {
  const roles = new Set<BotRole>();
  if (isAdmin) roles.add("admin");
  if (manager?.isActive) {
    roles.add("manager");
    const own = LINKED_ROLE[manager.role];
    if (own) roles.add(own);
  }
  return roles;
}

export async function resolveAccess(telegramUserId: string): Promise<Access> {
  const [isAdmin, manager] = await Promise.all([isBotAdmin(telegramUserId), findLinkedManager(telegramUserId)]);
  return { telegramUserId, isAdmin, manager, roles: rolesOf(isAdmin, manager) };
}

export function hasRole(access: Access, ...roles: BotRole[]): boolean {
  return roles.some((role) => access.roles.has(role));
}
