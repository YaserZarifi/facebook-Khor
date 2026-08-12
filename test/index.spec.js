import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateAutoSlots, repackQueue } from "../src/index.js";
import { isRateLimitError } from "../src/facebook.js";

describe("worker health check", () => {
	it("GET / responds ok", async () => {
		const worker = (await import("../src/index.js")).default;
		const request = new Request("http://example.com");
		const response = await worker.fetch(request, env, { waitUntil: () => {} });
		expect(await response.text()).toBe("ok");
	});

	it("webhook path rejects requests without the secret token", async () => {
		const worker = (await import("../src/index.js")).default;
		const request = new Request("http://example.com/webhook", { method: "POST", body: "{}" });
		const response = await worker.fetch(request, env, { waitUntil: () => {} });
		expect(response.status).toBe(403);
	});
});

describe("isRateLimitError", () => {
	it("matches known Facebook rate-limit codes", () => {
		expect(isRateLimitError('{"error":{"code":613,"message":"..."}}')).toBe(true);
		expect(isRateLimitError('{"error":{"code":4,"message":"..."}}')).toBe(true);
		expect(isRateLimitError("Too many requests")).toBe(true);
	});

	it("does not match unrelated errors", () => {
		expect(isRateLimitError("Invalid access token")).toBe(false);
		expect(isRateLimitError("")).toBe(false);
		expect(isRateLimitError(undefined)).toBe(false);
	});
});

describe("generateAutoSlots", () => {
	const fakeEnv = {
		MAX_UPLOADS_PER_DAY: "4",
		MIN_HOURS_BETWEEN_UPLOADS: "4",
		POSTING_WINDOW_START_HOUR: "11",
		POSTING_WINDOW_END_HOUR: "1",
		DISPLAY_TIMEZONE: "UTC",
	};

	it("returns the requested number of future slots", () => {
		const now = Date.now();
		const slots = generateAutoSlots(fakeEnv, now, 5);
		expect(slots.length).toBe(5);
		for (const t of slots) expect(t).toBeGreaterThanOrEqual(now - 60000);
	});

	it("returns slots in increasing order", () => {
		const now = Date.now();
		const slots = generateAutoSlots(fakeEnv, now, 6);
		for (let i = 1; i < slots.length; i++) {
			expect(slots[i]).toBeGreaterThan(slots[i - 1]);
		}
	});

	it("avoids blocked times within the minimum gap", () => {
		const now = Date.now();
		const blocked = [now + 2 * 60 * 60 * 1000];
		const gapMs = 4 * 60 * 60 * 1000;
		const slots = generateAutoSlots(fakeEnv, now, 3, blocked);
		for (const t of slots) {
			expect(Math.abs(t - blocked[0])).toBeGreaterThanOrEqual(gapMs);
		}
	});

	it("returns an empty array when count is 0", () => {
		expect(generateAutoSlots(fakeEnv, Date.now(), 0)).toEqual([]);
	});
});

describe("repackQueue", () => {
	const fakeEnv = {
		MAX_UPLOADS_PER_DAY: "4",
		MIN_HOURS_BETWEEN_UPLOADS: "4",
		POSTING_WINDOW_START_HOUR: "11",
		POSTING_WINDOW_END_HOUR: "1",
		DISPLAY_TIMEZONE: "UTC",
	};

	it("assigns scheduledAt to auto items and sorts the queue by time", () => {
		const queue = [
			{ id: "a", manual: false },
			{ id: "b", manual: false },
			{ id: "c", manual: false },
		];
		const result = repackQueue(fakeEnv, queue);
		expect(result.every((it) => typeof it.scheduledAt === "number")).toBe(true);
		for (let i = 1; i < result.length; i++) {
			expect(result[i].scheduledAt).toBeGreaterThanOrEqual(result[i - 1].scheduledAt);
		}
	});

	it("keeps a manual item's existing scheduledAt untouched", () => {
		const fixedTime = Date.now() + 10 * 60 * 60 * 1000;
		const queue = [
			{ id: "manual-1", manual: true, scheduledAt: fixedTime },
			{ id: "auto-1", manual: false },
		];
		const result = repackQueue(fakeEnv, queue);
		const manualItem = result.find((it) => it.id === "manual-1");
		expect(manualItem.scheduledAt).toBe(fixedTime);
	});
});
