import "dotenv/config";
import axios from "axios";

const AMO_BASE_URL = process.env.AMOCRM_BASE_URL;
const AMO_ACCESS_TOKEN = process.env.AMOCRM_ACCESS_TOKEN;

export const AMO_RESTRICTED_ROLE_ID = parseInt(process.env.AMO_RESTRICTED_ROLE_ID ?? "1201342");

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

// Assign a user to a role via PUT /api/v4/user_roles/{roleId}.
// Gets current users of the role, adds the target user, then PUTs the updated list.
export async function setAmoUserRole(amoUserId: number, roleId: number): Promise<void> {
  const getResp = await axios.get(
    `${AMO_BASE_URL}/api/v4/user_roles/${roleId}`,
    { headers: amoHeaders() }
  );
  const currentUsers: Array<{ id: number }> = getResp.data?._embedded?.users ?? [];
  console.log(`[amoRights] setAmoUserRole: role ${roleId} current users=${JSON.stringify(currentUsers)}`);

  const updatedUsers = currentUsers.some((u) => u.id === amoUserId)
    ? currentUsers
    : [...currentUsers, { id: amoUserId }];

  const resp = await axios.put(
    `${AMO_BASE_URL}/api/v4/user_roles/${roleId}`,
    { name: getResp.data?.name, users: updatedUsers },
    { headers: amoHeaders() }
  );
  console.log(`[amoRights] setAmoUserRole(${amoUserId} -> roleId=${roleId}) status=${resp.status}`);
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
