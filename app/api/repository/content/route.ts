import { NextRequest, NextResponse } from "next/server";
import { publicFetch, resolveChange } from "@/lib/gerrit-server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const sourceUrl = request.nextUrl.searchParams.get("url");
    const path = request.nextUrl.searchParams.get("path")?.replace(/^\/+/, "");
    const parent = request.nextUrl.searchParams.get("parent");
    if (!sourceUrl || !path || path.includes("\0") || path.split("/").includes("..")) {
      return NextResponse.json({ error: "Missing or invalid file path." }, { status: 400 });
    }

    const { parsed, revision } = await resolveChange(sourceUrl);
    const fileId = encodeURIComponent(path);
    const parentQuery = parent ? `?parent=${encodeURIComponent(parent)}` : "";
    const contentUrl = `${parsed.origin}/changes/${encodeURIComponent(parsed.change)}/revisions/${encodeURIComponent(revision)}/files/${fileId}/content${parentQuery}`;
    const response = await publicFetch(contentUrl, "text/plain", true);
    if (!response) return NextResponse.json({ exists: false, path });

    const encoded = (await response.text()).trim();
    if (encoded.length > 16_000_000) throw new Error("This file is too large to display.");
    const buffer = Buffer.from(encoded, "base64");
    const binary = buffer.subarray(0, 8_000).includes(0);
    if (binary) return NextResponse.json({ exists: true, binary: true, path, size: buffer.byteLength });
    return NextResponse.json(
      { exists: true, binary: false, path, content: buffer.toString("utf8"), size: buffer.byteLength },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=1800" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't load this file.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
