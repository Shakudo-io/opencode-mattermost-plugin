# Bug Log

## 2026-01-20: TypeScript error with channelId type mismatch

**Problem:** `Type 'string | undefined' is not assignable to type 'string'` in thread-mapping-store.ts

**Cause:** Interface `ThreadSessionMapping` had `channelId: string` but Zod schema had it optional for backward compatibility.

**Solution:** Changed interface to `channelId?: string` to match Zod schema.

**File:** `src/models/index.ts` line 172

---

## 2026-01-18: mmClient closure timing bug (v0.3.1 → v0.3.2)

**Problem:** Plugin crashed on disconnect due to accessing closed mmClient.

**Solution:** Added null checks before mmClient operations in disconnect flow.

---
