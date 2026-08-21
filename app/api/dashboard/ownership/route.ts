import { NextRequest, NextResponse } from "next/server";
import { parseGerritJson, publicFetch } from "@/lib/gerrit-server";
import { normalizeGerritServer } from "@/lib/gerrit-url";
import type { DashboardOwnership } from "@/lib/types";

type Owner = { id: number; name?: string };
type OwnersResponse = {
  files?: Record<string, Owner[]>;
};

function errorStatus(reason: unknown) {
  const message = reason instanceof Error ? reason.message : "Ownership could not be checked.";
  if (/valid Gerrit server URL|HTTP or HTTPS|credentials|Local Gerrit hosts|Private network addresses/i.test(message)) return 400;
  if (/returned 504/i.test(message)) return 504;
  return 502;
}

export async function GET(request: NextRequest) {
  const serverInput = request.nextUrl.searchParams.get("server")?.trim();
  const changeInput = request.nextUrl.searchParams.get("change")?.trim();
  const accountInput = request.nextUrl.searchParams.get("account")?.trim();
  if (!serverInput || !changeInput || !accountInput || !/^\d+$/.test(changeInput) || !/^\d+$/.test(accountInput)) {
    return NextResponse.json({ error: "A Gerrit server, change number, and account ID are required." }, { status: 400 });
  }

  try {
    const server = normalizeGerritServer(serverInput);
    const url = new URL(`changes/${changeInput}/revisions/current/owners~files-owners`, server);
    const response = await publicFetch(url.toString(), "application/json", true);
    if (!response) {
      const changeResponse = await publicFetch(new URL(`changes/${changeInput}`, server).toString(), "application/json", true);
      if (!changeResponse) {
        return NextResponse.json({ error: `Change ${changeInput} was not found on this Gerrit server.` }, { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      const unavailable: DashboardOwnership = { status: "unavailable", ownedPaths: 0, pendingPaths: 0, eligibleOwners: [] };
      return NextResponse.json(unavailable, { headers: { "Cache-Control": "no-store" } });
    }

    const input = parseGerritJson<OwnersResponse>(await response.text());
    const files = Object.entries(input.files ?? {});
    const accountId = Number(accountInput);
    const ownedPaths = files.filter(([, owners]) => owners.some((owner) => owner.id === accountId)).length;
    const eligibleOwners = [...new Set(files.flatMap(([, owners]) => owners.map((owner) => owner.name).filter((name): name is string => Boolean(name))))].sort((left, right) => left.localeCompare(right));
    let status: DashboardOwnership["status"];
    if (files.length === 0) status = "approved";
    else if (ownedPaths === 0) status = "not-owner";
    else if (ownedPaths === files.length) status = "owner-all";
    else status = "owner-some";

    const result: DashboardOwnership = {
      status,
      ownedPaths,
      pendingPaths: files.length,
      eligibleOwners,
    };
    return NextResponse.json(result, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch (reason) {
    return NextResponse.json(
      { error: reason instanceof Error ? reason.message : "Ownership could not be checked." },
      { status: errorStatus(reason), headers: { "Cache-Control": "no-store" } },
    );
  }
}
