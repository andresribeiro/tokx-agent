import type { UsageReport } from "./types.ts";

export interface UploadResult {
  readonly status: number;
  readonly body: string;
}

export async function uploadReport(
  backendUrl: string,
  token: string,
  report: UsageReport,
): Promise<UploadResult> {
  const url = `${backendUrl.replace(/\/+$/, "")}/usage/report`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ingest-key": token,
    },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  return { status: response.status, body };
}
