import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getUserFromSession } from "@/lib/user";
import { uploadNplListToCbs } from "@/actions/cbs-npl";
import { parseDayEnd, parseDayStart } from "@/lib/date-utils";

// Permission key used to gate access. Falls back to admin-level checks.
const REQUIRED_PERMS = ["npl-collection", "npl"] as const;

// Upper bound on rows returned to an export request, to keep the payload sane.
const EXPORT_ROW_CAP = 10000;

function userHasAnyPerm(user: any, action: "read" | "update" | "create"): boolean {
  if (!user?.permissions) return false;
  return REQUIRED_PERMS.some((key) => Boolean(user.permissions[key]?.[action]));
}

/** Trigger a daily NPL bulk upload to the CBS. */
export async function POST(req: NextRequest) {
  void req;
  const user = await getUserFromSession({ allowRefresh: false });
  if (!user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!userHasAnyPerm(user, "update") && !userHasAnyPerm(user, "create")) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  try {
    const result = await uploadNplListToCbs({ triggeredByUserId: user.id, source: "MANUAL" });
    return NextResponse.json(result, { status: result.success ? 200 : 502 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Internal Server Error" },
      { status: 500 },
    );
  }
}

/** List recent upload batches. */
export async function GET(req: NextRequest) {
  const user = await getUserFromSession({ allowRefresh: false });
  if (!user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!userHasAnyPerm(user, "read")) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  // `all=1` returns every matching row (capped) for spreadsheet exports.
  const exportAll = url.searchParams.get("all") === "1";

  const where: any = {};
  const fromDate = parseDayStart(from);
  const toDate = parseDayEnd(to);
  if (fromDate || toDate) {
    where.startedAt = {};
    if (fromDate) where.startedAt.gte = fromDate;
    if (toDate) where.startedAt.lte = toDate;
  }

  const [total, rows] = await Promise.all([
    prisma.nplCbsUploadBatch.count({ where }),
    prisma.nplCbsUploadBatch.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: exportAll ? undefined : (page - 1) * limit,
      take: exportAll ? EXPORT_ROW_CAP : limit,
    }),
  ]);

  return NextResponse.json({
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    truncated: exportAll && total > EXPORT_ROW_CAP,
    rows: rows.map((r) => ({
      id: r.id,
      source: r.source,
      status: r.status,
      accountsSentCount: r.accountsSentCount,
      totalReceived: r.totalReceived,
      insertedCount: r.insertedCount,
      alreadyExistsCount: r.alreadyExistsCount,
      httpStatus: r.httpStatus,
      errorMessage: r.errorMessage,
      triggeredByUserId: r.triggeredByUserId,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    })),
  });
}
