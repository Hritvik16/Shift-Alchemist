# Shift Alchemist — Performance Gate Log

Protocol (§4.4): production build (`npm run build && npm run preview`), Chrome, `F3` rolling stats over a 30 s scripted run, tab memory from Chrome Task Manager.

| Milestone | Date | Hardware | Build | p95 (ms) | p99 (ms) | Draw Calls | Tab Mem (MB) | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| M1.1 | TBD | 8GB M1 Air | preview | — | — | — | — | Cargo Hold BatchedMesh + debug carve |
| M2.1 | 2026-11-19 | 8GB M1 Air | preview (Firefox) | 17.20 | 17.64 | 430 (no multi_draw) | — | 4 shattered vats (9,529 fluid inst), Sim<=3ms Render<=3ms, Drift=0 |
| M2.2-lite (Tier A) | 2026-11-20 | 8GB M1 Air | preview (Firefox) | 16.86 | 17.56 | 439 (no multi_draw) | — | 60.0 FPS locked across 269k ticks, Sim 0ms / Render 3ms, 3,893 fluid inst, 0.1m volumetric Phase Explosions, 44/44 tests, Drift=0 |
