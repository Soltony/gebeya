import { NextRequest, NextResponse } from "next/server";
import { getUserFromSession } from "@/lib/user";
import { computeStaleCbsAccounts } from "@/actions/cbs-npl";

// Permission key used to gate access. Falls back to admin-level checks.
const REQUIRED_PERMS = ["npl-collection", "npl"] as const;

function userHasAnyPerm(user: any, action: "read" | "update" | "create"): boolean {
  if (!user?.permissions) return false;
  return REQUIRED_PERMS.some((key) => Boolean(user.permissions[key]?.[action]));
}

/**
 * Return accounts previously uploaded to the CBS that are no longer part of the
 * active NPL set and have not yet been deleted — i.e. candidates for cleanup.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromSession({ allowRefresh: false });
  if (!user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!userHasAnyPerm(user, "read")) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const url = new URL(req.url);
  const wantAll = ["1", "true"].includes((url.searchParams.get("all") ?? "").toLowerCase());
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));

  const all = await computeStaleCbsAccounts();
  const total = all.length;

  // `all=1` returns every candidate (used by the "Delete All" flow); otherwise
  // the list is paginated for display.
  const rows = wantAll ? all : all.slice((page - 1) * limit, (page - 1) * limit + limit);

  return NextResponse.json({
    page: wantAll ? 1 : page,
    limit: wantAll ? total : limit,
    total,
    totalPages: wantAll ? 1 : Math.max(1, Math.ceil(total / limit)),
    rows,
  });
}
