import "dotenv/config";
import axios from "axios";

const AMO_BASE_URL = process.env.AMOCRM_BASE_URL;
const AMO_ACCESS_TOKEN = process.env.AMOCRM_ACCESS_TOKEN;

export const AMO_RESTRICTED_ROLE_ID = parseInt(process.env.AMO_RESTRICTED_ROLE_ID ?? "626410");

function amoHeaders() {
  return {
    Authorization: `Bearer ${AMO_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
}

export async function getAmoUserRights(
  amoUserId: number
): Promise<Record<string, unknown> | null> {
  try {
    const resp = await axios.get(
      `${AMO_BASE_URL}/api/v4/users/${amoUserId}?with=role,group`,
      { headers: amoHeaders() }
    );
    return (resp.data?.rights as Record<string, unknown>) ?? null;
  } catch (err: any) {
    console.error(`[amoRights] getAmoUserRights failed for ${amoUserId}:`, err.message);
    return null;
  }
}

// Returns the current amoCRM role ID for a user.
// Checks rights.role_id first, then _embedded.roles[0].id.
export async function getAmoUserRoleId(amoUserId: number): Promise<number | null> {
  try {
    const resp = await axios.get(
      `${AMO_BASE_URL}/api/v4/users/${amoUserId}?with=role,group`,
      { headers: amoHeaders() }
    );
    const rights = resp.data?.rights as Record<string, unknown> | undefined;
    console.log(`[amoRights] getAmoUserRoleId(${amoUserId}) rights.role_id=${rights?.role_id} _embedded.roles=${JSON.stringify(resp.data?._embedded?.roles)}`);
    if (typeof rights?.role_id === "number") return rights.role_id;
    const roles = resp.data?._embedded?.roles as Array<{ id: number }> | undefined;
    if (roles?.[0]?.id) return roles[0].id;
    return null;
  } catch (err: any) {
    console.error(`[amoRights] getAmoUserRoleId failed for ${amoUserId}:`, err.response?.data ?? err.message);
    return null;
  }
}

export async function setAmoUserRole(amoUserId: number, roleId: number): Promise<void> {
  // Try 1: bulk endpoint with role_id inside rights
  try {
    const resp = await axios.patch(
      `${AMO_BASE_URL}/api/v4/users`,
      [{ id: amoUserId, rights: { role_id: roleId } }],
      { headers: amoHeaders() }
    );
    console.log(`[amoRights] setAmoUserRole attempt1 OK: status=${resp.status} data=${JSON.stringify(resp.data)}`);
    return;
  } catch (err: any) {
    console.warn(`[amoRights] setAmoUserRole attempt1 failed: status=${err.response?.status} data=${JSON.stringify(err.response?.data)} msg=${err.message}`);
  }

  // Try 2: bulk endpoint with role_id at top level
  try {
    const resp = await axios.patch(
      `${AMO_BASE_URL}/api/v4/users`,
      [{ id: amoUserId, role_id: roleId }],
      { headers: amoHeaders() }
    );
    console.log(`[amoRights] setAmoUserRole attempt2 OK: status=${resp.status} data=${JSON.stringify(resp.data)}`);
    return;
  } catch (err: any) {
    console.warn(`[amoRights] setAmoUserRole attempt2 failed: status=${err.response?.status} data=${JSON.stringify(err.response?.data)} msg=${err.message}`);
  }

  // Try 3: single-user endpoint with role_id at top level
  try {
    const resp = await axios.patch(
      `${AMO_BASE_URL}/api/v4/users/${amoUserId}`,
      { role_id: roleId },
      { headers: amoHeaders() }
    );
    console.log(`[amoRights] setAmoUserRole attempt3 OK: status=${resp.status} data=${JSON.stringify(resp.data)}`);
    return;
  } catch (err: any) {
    console.warn(`[amoRights] setAmoUserRole attempt3 failed: status=${err.response?.status} data=${JSON.stringify(err.response?.data)} msg=${err.message}`);
    throw new Error(`All 3 attempts failed. Last: status=${err.response?.status} data=${JSON.stringify(err.response?.data)}`);
  }
}

export async function restrictAmoUserLeads(amoUserId: number): Promise<void> {
  await axios.patch(
    `${AMO_BASE_URL}/api/v4/users/${amoUserId}`,
    {
      rights: {
        leads: { view: "M", edit: "M", add: "M", delete: "M" },
      },
    },
    { headers: amoHeaders() }
  );
}

export async function restoreAmoUserRights(
  amoUserId: number,
  rights: Record<string, unknown>
): Promise<void> {
  await axios.patch(
    `${AMO_BASE_URL}/api/v4/users/${amoUserId}`,
    { rights },
    { headers: amoHeaders() }
  );
}
