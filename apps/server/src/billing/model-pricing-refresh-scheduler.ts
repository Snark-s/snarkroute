import { refreshModelPricing } from "./model-pricing-refresh-service";
import { appMode } from "../services/env";

let schedulerStarted = false;

export function startModelPricingRefreshScheduler(): void {
  if (schedulerStarted) return;
  if (appMode() !== "cloud") return;
  if (!truthy(process.env.MODEL_PRICING_REFRESH_ENABLED)) return;
  schedulerStarted = true;
  if (truthy(process.env.MODEL_PRICING_REFRESH_ON_STARTUP)) {
    void runScheduledRefresh("startup");
  }
  const interval = setInterval(() => {
    if (shouldRunNow(new Date(), process.env.MODEL_PRICING_REFRESH_CRON ?? "0 3 * * *")) {
      void runScheduledRefresh("daily");
    }
  }, 60_000);
  interval.unref?.();
}

async function runScheduledRefresh(reason: "startup" | "daily"): Promise<void> {
  try {
    const result = await refreshModelPricing("all");
    console.info(`[model-pricing-refresh] ${reason}: ${JSON.stringify({ refreshed: result.refreshed, failed: result.failed.length, warnings: result.warnings.length, pricesUpdated: result.pricesUpdated })}`);
  } catch (error) {
    console.warn(`[model-pricing-refresh] ${reason} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function shouldRunNow(date: Date, cron: string): boolean {
  const [minute = "0", hour = "3"] = cron.trim().split(/\s+/);
  return date.getUTCMinutes() === Number(minute) && date.getUTCHours() === Number(hour);
}

function truthy(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes";
}
