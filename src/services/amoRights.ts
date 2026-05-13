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

// Assign a user to a role via the internal amoCRM AJAX endpoint POST /ajax/v1/users/set/
// This mirrors what the browser does when an admin changes a user's role in the UI.
export async function setAmoUserRole(amoUserId: number, roleId: number): Promise<void> {
  // Fetch user info (name, email, group_id) needed for the AJAX payload
  const userResp = await axios.get(
    `${AMO_BASE_URL}/api/v4/users/${amoUserId}?with=role,group`,
    { headers: amoHeaders() }
  );
  const user = userResp.data;
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

  // amoCRM AJAX returns 200 even on auth failures — check response body
  if (typeof resp.data === "string" && resp.data.includes("<html")) {
    throw new Error(`AJAX auth failed (got HTML login page). Refresh AMO_SESSION_TOKEN in Railway env vars.`);
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
