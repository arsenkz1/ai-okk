import "dotenv/config";
import axios from "axios";
import { normalizeAmoCrmTenantBaseUrl } from "./amoCrmRateLimiter";
import { HIDDEN_NEW_LEAD_STAGES } from "../config/disciplinePilot";

const AMO_BASE_URL = process.env.AMOCRM_BASE_URL
  ? normalizeAmoCrmTenantBaseUrl(process.env.AMOCRM_BASE_URL)
  : undefined;
const AMO_ACCESS_TOKEN = process.env.AMOCRM_ACCESS_TOKEN;

export const AMO_RESTRICTED_ROLE_ID = parseInt(process.env.AMO_RESTRICTED_ROLE_ID ?? "1201342");

type AccessValue = "A" | "G" | "M" | "D";

interface AmoEntityRights {
  view?: AccessValue;
  edit?: AccessValue;
  add?: AccessValue;
  delete?: AccessValue;
  export?: AccessValue;
}

interface AmoTaskRights {
  edit?: AccessValue;
  delete?: AccessValue;
}

interface AmoRoleRightsPatchPayload {
  leads: Required<AmoEntityRights>;
  contacts: Required<AmoEntityRights>;
  companies: Required<AmoEntityRights>;
  tasks: Required<AmoTaskRights>;
  mail_access: boolean;
  catalog_access: boolean;
  status_rights: AmoStatusRightPatch[];
}

export interface AmoStatusRight {
  entity_type: "leads";
  pipeline_id: number;
  status_id: number;
  rights: {
    view: AccessValue;
    edit: AccessValue;
    delete: AccessValue;
    export?: AccessValue;
  };
}

interface AmoStatusRightPatch {
  entity_type: "leads";
  pipeline_id: number;
  status_id: number;
  rights: {
    view: AccessValue;
    edit: AccessValue;
    delete: AccessValue;
    export?: AccessValue;
  };
}

export interface AmoRoleRights {
  leads: AmoEntityRights;
  contacts: AmoEntityRights;
  companies: AmoEntityRights;
  tasks: AmoTaskRights;
  mail_access?: boolean;
  catalog_access?: boolean;
  is_admin?: boolean;
  is_free?: boolean;
  is_active?: boolean;
  group_id?: number | null;
  role_id?: number | null;
  status_rights?: AmoStatusRight[] | null;
}

interface AmoRoleResponse {
  id: number;
  name: string;
  rights: AmoRoleRights;
  _embedded?: {
    users?: Array<number | { id?: number | null }>;
  };
}

function amoHeaders() {
  return {
    Authorization: `Bearer ${AMO_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function cloneRights<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function hiddenStageKey(pipelineId: number, statusId: number): string {
  return `${pipelineId}:${statusId}`;
}

function normalizeAccessValue(value: AccessValue | undefined, fallback: AccessValue): AccessValue {
  return value ?? fallback;
}

function normalizeStatusRight(item: AmoStatusRight): AmoStatusRightPatch {
  const fallback = item.rights.view ?? "D";
  const normalized: AmoStatusRightPatch = {
    ...item,
    rights: {
      view: normalizeAccessValue(item.rights.view, fallback),
      edit: normalizeAccessValue(item.rights.edit, fallback),
      delete: normalizeAccessValue(item.rights.delete, fallback),
    },
  };
  if (item.rights.export) {
    normalized.rights.export = normalizeAccessValue(item.rights.export, fallback);
  }
  return normalized;
}

function normalizeEntityRights(
  rights: AmoEntityRights | undefined,
  fallback: AccessValue = "D"
): Required<AmoEntityRights> {
  return {
    view: normalizeAccessValue(rights?.view, fallback),
    edit: normalizeAccessValue(rights?.edit, fallback),
    add: normalizeAccessValue(rights?.add, fallback),
    delete: normalizeAccessValue(rights?.delete, fallback),
    export: normalizeAccessValue(rights?.export, fallback),
  };
}

function normalizeTaskRights(
  rights: AmoTaskRights | undefined,
  fallback: AccessValue = "D"
): Required<AmoTaskRights> {
  return {
    edit: normalizeAccessValue(rights?.edit, fallback),
    delete: normalizeAccessValue(rights?.delete, fallback),
  };
}

function normalizeRoleRights(rights: AmoRoleRights): AmoRoleRightsPatchPayload {
  const nextRights = cloneRights(rights);
  const leads = normalizeEntityRights(nextRights.leads, "A");
  const contacts = normalizeEntityRights(nextRights.contacts, "A");
  const companies = normalizeEntityRights(nextRights.companies, "A");

  // Keep top-level delete/export disabled regardless of discipline state.
  leads.delete = "D";
  leads.export = "D";
  contacts.delete = "D";
  contacts.export = "D";
  companies.delete = "D";
  companies.export = "D";

  return {
    leads,
    contacts,
    companies,
    tasks: normalizeTaskRights(nextRights.tasks, "A"),
    mail_access: Boolean(nextRights.mail_access),
    catalog_access: Boolean(nextRights.catalog_access),
    status_rights: Array.isArray(nextRights.status_rights)
      ? nextRights.status_rights.map((item) => normalizeStatusRight(item))
      : [],
  };
}

function extractEmbeddedUserIds(role: AmoRoleResponse): number[] {
  const users = role._embedded?.users ?? [];
  const ids = users
    .map((item) => {
      if (typeof item === "number") return item;
      return item?.id ?? null;
    })
    .filter((id): id is number => typeof id === "number" && Number.isFinite(id));
  return [...new Set(ids)];
}

function buildRestrictedRoleRights(originalRights: AmoRoleRights): AmoRoleRights {
  const nextRights = normalizeRoleRights(originalRights);
  const currentStatusRights = Array.isArray(nextRights.status_rights)
    ? [...nextRights.status_rights]
    : [];

  const hiddenKeys = new Set(
    HIDDEN_NEW_LEAD_STAGES.map((item) => hiddenStageKey(item.pipelineId, item.statusId))
  );

  const preservedStatusRights = currentStatusRights.filter(
    (item) => !hiddenKeys.has(hiddenStageKey(item.pipeline_id, item.status_id))
  );

  const restrictedStatusRights: AmoStatusRightPatch[] = HIDDEN_NEW_LEAD_STAGES.map((item) => ({
    entity_type: "leads",
    pipeline_id: item.pipelineId,
    status_id: item.statusId,
    rights: {
      view: "D",
      edit: "D",
      delete: "D",
      export: "D",
    },
  }));

  nextRights.status_rights = [...preservedStatusRights, ...restrictedStatusRights];
  return nextRights;
}

async function amoGet<T>(path: string): Promise<T> {
  const resp = await axios.get(`${AMO_BASE_URL}${path}`, { headers: amoHeaders() });
  return resp.data as T;
}

async function amoPatch<T>(path: string, data: unknown): Promise<T> {
  try {
    const resp = await axios.patch(`${AMO_BASE_URL}${path}`, data, { headers: amoHeaders() });
    return resp.data as T;
  } catch (err: any) {
    const details = err.response?.data
      ? typeof err.response.data === "string"
        ? err.response.data
        : JSON.stringify(err.response.data)
      : err.message;
    console.error(`[amoRights] PATCH ${path} failed: ${details}`);
    throw err;
  }
}

async function getAmoUser(amoUserId: number): Promise<any> {
  return amoGet<any>(`/api/v4/users/${amoUserId}?with=role,group`);
}

export async function getAmoUserRights(
  amoUserId: number
): Promise<Record<string, unknown> | null> {
  try {
    const resp = await getAmoUser(amoUserId);
    return (resp?.rights as Record<string, unknown>) ?? null;
  } catch (err: any) {
    console.error(`[amoRights] getAmoUserRights failed for ${amoUserId}:`, err.message);
    return null;
  }
}

export async function getAmoUserRoleId(amoUserId: number): Promise<number | null> {
  try {
    const resp = await getAmoUser(amoUserId);
    const rights = resp?.rights as Record<string, unknown> | undefined;
    console.log(
      `[amoRights] getAmoUserRoleId(${amoUserId}) rights.role_id=${rights?.role_id} _embedded.roles=${JSON.stringify(resp?._embedded?.roles)}`
    );
    if (typeof rights?.role_id === "number") return rights.role_id;
    const roles = resp?._embedded?.roles as Array<{ id: number }> | undefined;
    if (roles?.[0]?.id) return roles[0].id;
    return null;
  } catch (err: any) {
    console.error(`[amoRights] getAmoUserRoleId failed for ${amoUserId}:`, err.response?.data ?? err.message);
    return null;
  }
}

export async function getAmoRole(roleId: number): Promise<AmoRoleResponse> {
  return amoGet<AmoRoleResponse>(`/api/v4/roles/${roleId}?with=users`);
}

export async function updateAmoRoleRights(roleId: number, rights: AmoRoleRights): Promise<AmoRoleResponse> {
  return amoPatch<AmoRoleResponse>(`/api/v4/roles/${roleId}`, {
    rights: normalizeRoleRights(rights),
  });
}

export async function prepareRestrictedRoleRights(
  amoUserId: number,
  amoRoleId: number
): Promise<{
  originalRights: AmoRoleRights;
  restrictedRights: AmoRoleRights;
  embeddedUserIds: number[];
}> {
  const currentUserRoleId = await getAmoUserRoleId(amoUserId);
  if (currentUserRoleId !== amoRoleId) {
    throw new Error(
      `User ${amoUserId} is assigned to role ${currentUserRoleId ?? "null"}, expected ${amoRoleId}`
    );
  }

  const role = await getAmoRole(amoRoleId);
  const embeddedUserIds = extractEmbeddedUserIds(role);
  if (embeddedUserIds.length > 1) {
    throw new Error(`Role ${amoRoleId} is shared by multiple users: ${embeddedUserIds.join(", ")}`);
  }
  if (embeddedUserIds.length === 1 && embeddedUserIds[0] !== amoUserId) {
    throw new Error(`Role ${amoRoleId} belongs to user ${embeddedUserIds[0]}, expected ${amoUserId}`);
  }

  const originalRights = cloneRights(role.rights);
  return {
    originalRights,
    restrictedRights: buildRestrictedRoleRights(originalRights),
    embeddedUserIds,
  };
}

export async function restrictAmoRoleNewLeadAccess(
  amoUserId: number,
  amoRoleId: number
): Promise<{ originalRights: AmoRoleRights; embeddedUserIds: number[] }> {
  const { originalRights, restrictedRights, embeddedUserIds } = await prepareRestrictedRoleRights(
    amoUserId,
    amoRoleId
  );
  await updateAmoRoleRights(amoRoleId, restrictedRights);
  return { originalRights, embeddedUserIds };
}

export async function restoreAmoRoleRights(
  amoRoleId: number,
  rights: AmoRoleRights
): Promise<void> {
  await updateAmoRoleRights(amoRoleId, rights);
}

// Assign a user to a role via the internal amoCRM AJAX endpoint POST /ajax/v1/users/set/
// This mirrors what the browser does when an admin changes a user's role in the UI.
export async function setAmoUserRole(amoUserId: number, roleId: number): Promise<void> {
  const user = await getAmoUser(amoUserId);
  const name: string = user.name ?? "";
  const email: string = user.email ?? "";
  const groupId: number | string = user._embedded?.groups?.[0]?.id ?? "";

  const params = new URLSearchParams();
  params.append("request[users][update][id]", String(amoUserId));
  params.append("request[users][update][name]", name);
  params.append("request[users][update][email]", email);
  params.append("request[users][update][group_id]", String(groupId));
  params.append("request[users][update][active]", "Y");
  params.append("request[users][update][password]", "");
  params.append("request[users][update][role_id]", String(roleId));

  const resp = await axios.post(
    `${AMO_BASE_URL}/ajax/v1/users/set/`,
    params.toString(),
    {
      timeout: 10000,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "X-Session-Token": process.env.AMO_SESSION_TOKEN ?? "",
      },
    }
  );
  const dataStr = typeof resp.data === "string"
    ? resp.data.slice(0, 300)
    : JSON.stringify(resp.data).slice(0, 300);
  console.log(`[amoRights] setAmoUserRole AJAX(${amoUserId} -> roleId=${roleId}) status=${resp.status} data=${dataStr}`);

  if (typeof resp.data === "string" && resp.data.includes("<html")) {
    throw new Error("AJAX auth failed (got HTML login page). Refresh AMO_SESSION_TOKEN in Railway env vars.");
  }
  if (resp.data?.response?.error) {
    throw new Error(`AJAX error: ${JSON.stringify(resp.data.response.error)}`);
  }
}

export async function restrictAmoUserLeads(amoUserId: number): Promise<void> {
  const resp = await axios.patch(
    `${AMO_BASE_URL}/api/v4/users`,
    [{ id: amoUserId, rights: { leads: { view: "M", edit: "M", add: "M", delete: "M" } } }],
    { headers: amoHeaders() }
  );
  console.log(`[amoRights] restrictAmoUserLeads(${amoUserId}) status=${resp.status}`);
}

export async function restoreAmoUserRights(
  amoUserId: number,
  rights: Record<string, unknown>
): Promise<void> {
  const resp = await axios.patch(
    `${AMO_BASE_URL}/api/v4/users`,
    [{ id: amoUserId, rights }],
    { headers: amoHeaders() }
  );
  console.log(`[amoRights] restoreAmoUserRights(${amoUserId}) status=${resp.status}`);
}
