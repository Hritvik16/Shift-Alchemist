# SHIFT ALCHEMIST — Design & Technical Execution Specification

## 1. High-Concept Pitch
**Shift Alchemist** is a 3D isometric action roguelite set aboard a derelict industrial freighter overrun by procedurally mutated Xenomorphs. Armed with a **Pressurized Fluid Nozzle**, a **Vacuum Siphon**, a **Fluid-Plumbed Jetpack**, and a **Local Gravity-Shift Pulse**, the player manipulates a real-time 3D voxel sandbox of **Water, Oil, Cryo-Coolant, Fire, Electricity, Wood, Ice, Glass, and Steel**—turning the ship's failing gravity and volatile cargo into high-speed kinetic and elemental chain reactions.

---

## 2. Core Architecture & Performance Contract
To guarantee a locked **60 FPS** on Apple Silicon (M1 8GB) while supporting true 3D verticality:
* **Strict Separation of Concerns:**
  * `src/core/`: Pure TypeScript simulation state, 3D voxel stencils, procedural WFC room generation, and entity physics. **Zero Three.js or DOM imports.**
  * `src/viewer/`: Three.js isometric cutaway diorama renderer, instanced voxel/fluid meshes, dynamic lighting, and 3D lock-on HUD.
* **Sub-Meter 3D Voxel Grid (`0.5m` Resolution):**
  * **Max Room Footprint:** `32 x 12 x 32` voxels (`12,288` max cells per room = `16m wide x 6m tall x 16m deep`).
  * **Variable Room Archetypes:** The `32 x 12 x 32` bounds act as an upper ceiling, allowing rooms of any proportion:
    * *Tight Corridor:* `10 x 8 x 32` (claustrophobic horizontal choke points).
    * *Vertical Reactor Shaft:* `20 x 12 x 20` (multi-tiered platforms, high catwalks with stairs/ramps, and deep pits).
    * *Main Cargo Hold:* `32 x 12 x 32` (open arena with stacked timber crates, suspended glass vats, and overhead cranes).
  * **Flat 1D Memory Indexing:** All 3D grids (`matGrid`, `volGrid`, `tempGrid`, `voltGrid`) are flat TypedArrays indexed by:
    `idx = y * (width * depth) + z * width + x`
  * **Entity-to-Voxel Proxy Coupling:** Loose rigid bodies (`Wood_Crates`, `0G` fluid spheres, and Aliens) move in continuous 3D space `(X, Y, Z)` with velocity `V`, and each frame stamp their material ID and volume into the underlying `0.5m` voxel cells they overlap so the 3D thermal and electrical stencils interact with them seamlessly.
  * **Sparse Active-Cell Stencil:** The 6-neighbor 3D stencil (`+X, -X, +Y, -Y, +Z, -Z`) skips empty `AIR` cells (`matId === 0`), updating only active solid/fluid/thermal/electrical cells (~800–1,500 cells/frame, <0.4ms CPU time).

---

## 3. Camera, Orientation & 3D Spatial Readability
* **Hades-Style 3D Isometric Cutaway Camera (~48° Pitch):**
  * **North, West, and East Bulkheads:** Full height (up to `6m`) with pipes, vents, catwalks, stairs, and airlock doors.
  * **South (Camera-Facing) Bulkheads:** Automatically cut away to `0.6m` waist-high rims so the player and enemies are never occluded.
  * **Room-by-Room Fog of War:** Adjacent WFC rooms remain dark/unrendered until their connecting airlock door is opened or breached.
* **Gyro-Stabilized Humanoid Rig ("Down is Always Down"):**
  * The player wears a gyro-stabilized industrial exo-suit that remains upright relative to the ship's deck (`+Y` is always ceiling, `-Y` is always deck floor). No disorienting pitch/roll cameras.
  * **Laser Plumb-Line & Floor Ring:** Whenever the player or any entity/fluid blob is airborne (`Y > 0.2m`), a crisp vertical laser line projects straight down to a glowing floor ring at `(X, 0, Z)`, making 3D altitude and ground alignment unmistakable.
  * **3D Magnetic Target Lock-On:** Moving the cursor near any enemy, floating fluid sphere, or glass tank at *any* altitude `Y` snaps a 3D Lock-On Reticle onto its `(X, Y, Z)` center. Ranged nozzle shots and `0G` jetpack dashes automatically pitch in 3D toward the locked target (or 3D cursor raycast point).

---

## 4. Player Controls & Combat Kit
1. **Movement (`WASD` + Vertical Altitude in `0G`):**
   * **In `1G` (Standard Deck Gravity):** Snappy ground running (`WASD`) on floors, crates, stairs/ramps, and elevated catwalks.
   * **In `0G` (Weightless Suspension):** Low-friction micro-thruster skating (`WASD` for horizontal `X/Z`, `E` to ascend `+Y`, `Left-Shift` to descend `-Y` freely across `[0.5m, 5.5m]`).
2. **Left-Click — Pressurized Nozzle (Ranged):**
   * **Empty Tank:** Fires rapid **Compressed Air Bursts** that push enemies, loose wooden crates, and floating `0G` fluid spheres (applying slight Newton's-third-law recoil to the player in `0G`).
   * **Loaded Tank (Tap Left-Click):** Fires a snappy **3-Shot Pressure Burst** (*Pop-Pop-BLAST!*) that staggers enemies and splatters fluid at the target's 3D `(X, Y, Z)` position.
   * **Loaded Tank (Hold Left-Click):** Continuous pressurized hose stream.
3. **Right-Click — Vacuum Siphon Beam:**
   * Projects a short-range vacuum cone that pulls floor puddles (`1G`), floating fluid spheres (`0G`), or biological fluids straight out of wounded/stunned Aliens into the player's back-tank.
4. **Space — Fluid-Plumbed Jetpack Dash:**
   * **In `1G`:** Launches a high-speed horizontal dash along the player's current `WASD` movement heading (smoothly climbing stairs and ramps via step-up collision).
   * **In `0G`:** Launches a 3D vector boost directly toward the 3D mouse cursor or locked-on target `(X, Y, Z)`.
   * **Plumbed Exhaust:** Expels a trail of whatever fluid (plus its thermal/electrical charge) is currently in the player's active tank chamber along the dash trajectory.
   * **Thruster Attachments (Upgrades):** End-of-dash triggers (e.g., *Spark-Plug Igniter* auto-ignites an `Oil` dash trail into a mid-air wall of fire; *Piezo-Arc Coil* electrifies a `Water` dash trail).
5. **`Q` (or Mouse Side/Wheel) — Suit Gravity-Pulse (Cooldown):**
   * Hacks the active room's gravity plating to toggle between **`1G`** and **`0G`** (with **`2G/3G` Hyper-Gravity Crush** and **`-1G` Ceiling Inversion** unlocked as run upgrades).
   * **`1G -> 0G`:** Floor puddles lift into floating 3D spheres; unanchored crates and non-clinging enemies float weightlessly mid-air.
   * **`0G -> 1G / 2G`:** All airborne enemies, crates, and floating fluid spheres accelerate rapidly straight down (`-Y`), splashing fluids across a wide radius and taking/dealing kinetic impact damage via the **Universal Wall-Splat Rule (`Mass * V^2`)** upon slamming into the floor or entities below.

---

## 5. The Universal Grid Laws & Material Sandbox (Zero Scripted Combos)
Every voxel cell has a `MaterialID` with static physical constants (`Conductivity`, `Flammability`, `Viscosity`, `StructuralIntegrity`) plus dynamic `Volume (0.0–1.0)`, `Temperature (T)`, and `Voltage (V)`:

| Material | Type | Conductivity | Flammability | Behavior in `1G` vs `0G` & Emergent Interactions |
| :--- | :--- | :--- | :--- | :--- |
| **Water / Coolant** | Fluid | High (`0.9`) | `0.0` | Flows on floor (`1G`) or forms 3D spheres (`0G`). Conducts electricity (`Ohm's Law`); douses Fire; flashes to explosive **Steam** at `T >= 100°C`; freezes into solid **Ice** at `T <= 0°C`. |
| **Hydrocarbon Oil** | Fluid | Insulator (`0.0`) | Extreme (`1.0`) | Sticky tar in `1G` (slows enemies); floating black spheres in `0G`. Ignites at `T >= 180°C`, burning at `650°C` and heating adjacent cells. |
| **Cryo-Coolant (LN2)**| Fluid | Insulator (`0.0`) | `0.0` | Ultra-cold liquid (`T = -196°C`). Freezes `Water` into `Ice`; embrittles `Wood` and `Thermal Shell` aliens (`3x` kinetic shatter damage at `T <= -50°C`); flashes into a **Cryo Boil-Off Shockwave** when hitting hot surfaces (`T >= 100°C`). |
| **Timber / Wood Crate** | Solid (Loose) | Insulator (`0.0`) | High (`0.7`) | Destructible cover. Floats in `0G`; crushes enemies when slammed down in `1G/2G`; catches fire at `T >= 220°C`; splinters under high-pressure impacts. |
| **Glass Vat / Window** | Solid (Brittle)| Insulator (`0.0`) | `0.0` | Holds pressurized fluids inside tanks. Shatters under kinetic wall-splats, pressure blasts, or thermal shock. |
| **Hull Steel / Grate** | Solid (Static) | Max (`1.0`) | `0.0` | Indestructible room structure, stairs & catwalks. Conducts electricity and heat (becomes superconducting below `-100°C`). |
| **Ice Block** | Solid (Phase) | Insulator (`0.0`) | `0.0` | Created when `Water` drops to `T <= 0°C` (in air or on floor). Blocks movement/projectiles; shatters under kinetic impact. |

* **Universal Explosion Rule (Rapid Phase Expansion):** Any liquid voxel that transitions to Gas (`Water -> Steam` at `T >= 100°C`, or `Cryo-Coolant -> Nitrogen Gas` when contacting `T >= 100°C` heat/fire) in a single tick expands `10x` in volume, generating an automatic 3D radial pressure wave that hurls entities, shatters nearby `Glass`, and scatters fluids.
* **Universal Wall-Splat & Gravity-Slam Rule:** Any entity or loose crate colliding with a solid voxel (`Hull_Steel`, `Wood_Crate`, `Ice`) or another entity at relative velocity `V` above threshold takes and deals kinetic damage proportional to `Mass * V^2` (with a `3x` multiplier if the target is Cryo-embrittled at `T <= -50°C`).

---

## 6. Procedural Alien Xenomorph System
Aliens are procedurally generated from modular biological traits that interact directly with the physics sandbox:
1. **Locomotion Archetype:**
   * *Chitin Skitterer:* Fast floor/wall runner in `1G`; helplessly tumbles in `0G` if knocked off a surface.
   * *Gas-Bladder Floater:* Hovers at high `Y` altitude; violently accelerated into the floor when gravity shifts to `1G/2G`.
   * *Dense Crusher:* Heavy charger in `1G`; turns into a high-mass kinetic projectile when punted in `0G`.
2. **Elemental Gland (Internal Fluid & Attack):**
   * *Hydro-Mucus:* Pressurized `Water` (`T = 20°C`).
   * *Volatile Bile:* Sticky `Oil` (`T = 20°C`).
   * *Pyro-Spitter:* Self-igniting **Pyro-Napalm** (`Oil` stored at `T = 200°C`—ignites on air contact).
   * *Bio-Voltaic:* **Charged Electrolyte** (`Water` stored at `V = 120V`—arcs electricity on contact).
   * *Cryo-Spitter:* Sub-zero **Cryo-Coolant** (`LN2` stored at `T = -196°C`—freezes water and embrittles targets).
   * **Siphonable Biology:** Wounded or stunned aliens can be vacuum-siphoned (`Right-Click`) to harvest their internal fluid (along with its thermal/voltage charge) directly into the player's tank.
3. **Carapace / Armor Gene (Physical Vulnerability):**
   * *Thermal Shell:* Immune to fire (`T > 0°C`), but cracks brittle (`3x` kinetic shatter damage) when cooled by `Water` or `Cryo-Coolant` (`T <= -50°C`).
   * *Insulated Hide:* Immune to electricity, but coated in flammable resin (ignites immediately from heat/sparks).
   * *Spined Exoskeleton:* Reflects close-range contact, forcing the player to use ranged pressure blasts, elemental hazards, or `Mass * V^2` wall-splats/gravity slams.

---

## 7. Progression & 5-Minute WFC Deck Loop
* **3D Wave Function Collapse (WFC) Deck Layout:**
  * Each floor is a 5–8 minute expedition across **10–14 interconnected 3D ship compartments** (Corridors, Cargo Holds, Hydroponics, Bilge Tanks, Reactor Shafts) culminating in a **Boss Sanctum**.
* **Tank & Suit Progression:**
  1. **Single Unbaffled Tank (Starter) -> Baffled Multi-Chamber Tank (Upgrade):**
     * *Starter Hazard:* One single tank chamber storing fluid (`Water`, `Oil`, or `Cryo`) plus scalar `TankTemp` and `TankVoltage`. Siphoning a second incompatible fluid mixes/dilutes pressure, and siphoning burning Pyro-Napalm (`T >= 180°C`), Charged Electrolyte (`V > 0`), or Cryo into a volatile tank triggers a **Tank Backfire Explosion**.
     * *Baffled Upgrade:* Splits the tank into isolated chambers and unlocks the **Proportioning Valve** (route Chamber A to your Left-Click Nozzle and Chamber B to your Space Jetpack).
  2. **Base Stat Scaling:** Nozzle Pressure (velocity/knockback), Tank Capacity (`L`), Siphon Rate, and Gravity-Pulse Cooldown.
  3. **Nozzle & Thruster Attachments:** *Spark-Plug Igniter*, *Piezo-Arc Coil*, *Cryo-Expansion Nozzle*, and *`2G/3G` Crush Capacitor*.

---

## 8. Incremental Micro-Milestone Execution Plan (Testable at Every Stage)
Each micro-milestone must be implemented, compiled, and playtested at 60 FPS via its **Playtest Gate** before moving to the next:

### Phase 1: The Kinetic 3D Sandbox (Room, Physics & Target Dummy)
* **Milestone 1.1 — 3D Voxel Room Data Structure, Cutaway Renderer & Debug Spawner HUD:**
  * Implement `src/core/types.ts` and `src/core/roomGen.ts` for a `32 x 12 x 32` (`0.5m` voxel) test room containing a steel floor, full-height North/West/East bulkheads, a cutaway `0.6m` South wall, a `4.5m` elevated catwalk connected by walkable stairs/ramp, and a sunken pit.
  * Implement `src/viewer/scene3D.ts` with a Hades-style (~48° pitch) isometric camera, dirty-flagged `InstancedMesh` voxel rendering, and a lightweight **Debug Spawner HUD** (FPS counter, active stencil cell count, 3D cursor coordinates, and number keys `1–6` to spawn test props/fluids at the cursor).
  * *Playtest Gate:* Verify 60 FPS cutaway rendering, clear depth readability in the pit and catwalk, and accurate 3D mouse raycasting across floor and elevated surfaces.

* **Milestone 1.2 — 1G/0G Player Controller, Laser Plumb-Line & Unified Velocity Physics:**
  * Build the 3D humanoid mesh group (Head/Visor, Torso, Limbs, Twin Jetpack Thrusters) with snappy `1G` `WASD` ground movement, stair climbing, ledge drop-offs, mouse-cursor yaw rotation, and the vertical Laser Plumb-Line + floor ring indicator.
  * Add the `Q` Suit Gravity-Pulse toggle (`1G` vs `0G`), `0G` weightless hover inertia with `E`/`Left-Shift` vertical altitude flight (`0.5m` to `5.5m`), and a unified 3D velocity/gravity integrator applying the **Universal Wall-Splat Rule (`Mass * V^2`)**.
  * *Playtest Gate:* Run up the stairs to the `4.5m` catwalk in `1G`, toggle `0G` to fly across the room, and toggle `1G` mid-air to verify smooth gravitational acceleration and floor impact detection.

* **Milestone 1.3 — Loose Crates, Brittle Glass Vats, Base Alien Dummy, 3D Lock-On & Air Nozzle:**
  * Add dynamic 3D `Wood_Crate` bodies, destructible `Glass_Vat` containers, and a **Base Alien Target Dummy** (with health, hit-stun frames, and 3D collision) coupled to the voxel grid via proxy cells.
  * Implement the 3D Magnetic Target Lock-On reticle, `Left-Click` Compressed Air Bursts (with `0G` player recoil), and `Space` Jetpack Dash (horizontal along `WASD` heading in `1G`; 3D vector boost toward cursor/lock-on target in `0G`).
  * *Playtest Gate:* Lock onto the Alien Dummy and wooden crates at different altitudes, punt them into walls with air bursts to trigger `Mass * V^2` wall-splat damage, shatter glass vats, and slam airborne aliens from `0G` to `1G`.

### Phase 2: The Reactive Elemental Voxel Grid (Fluids, Stencils & Hazard Emitters)
* **Milestone 2.1 — 3D Fluid Voxels (`Water`, `Oil`, `Cryo-Coolant`) in `1G` vs `0G`:**
  * Add fractional fluid volume (`0.0–1.0`) to the 3D voxel grid, rendering `1G` fluids as shallow surface puddles that flow down stairs/pits, and `0G` fluids as coalescing 3D floating spheres suspended in mid-air.
  * Populate the test room with pre-filled `Glass_Vat` tanks containing `Water`, `Oil`, and `Cryo-Coolant`.
  * *Playtest Gate:* Shatter `Glass_Vat` tanks with Compressed Air; verify fluids pour into the sunken pit in `1G`, lift into floating 3D spheres when shifting to `0G`, and splash radially when slammed back to `1G`.

* **Milestone 2.2 — Thermal/Electrical 3D Stencils & Static Room Hazard Emitters:**
  * Implement the sparse 6-neighbor heat and voltage stencils (`Oil` ignites at `T >= 180°C` burning at `650°C`; `Wood_Crate` ignites at `T >= 220°C`; `Water` flashes to radial-impulse `Steam` at `T >= 100°C` or freezes to solid `Ice` at `T <= 0°C`; `Cryo-Coolant` freezes water, embrittles targets at `T <= -50°C`, and triggers a Cryo Boil-Off Shockwave at `T >= 100°C`; `Water` and `Hull_Steel` conduct voltage).
  * Place three static **Environmental Hazard Voxels** in the test room—a *Sparking Conduit* (`+120V`), a *Thermal Steam Vent* (`+300°C`), and a *Leaking Cryo Pipe* (`-196°C`)—so every elemental reaction can be tested immediately.
  * *Playtest Gate:* Push `Water`, `Oil`, and `Cryo-Coolant` into the room hazards using your Air Nozzle; verify the Alien Dummy takes shock, burn, freeze-shatter (`3x` wall-splat), and steam/cryo explosion knockback while active stencil CPU time remains `<0.4ms`.

### Phase 3: The Alchemist Suit Loop (Siphon, Tank Mixing & Attachments)
* **Milestone 3.1 — Vacuum Siphon (`Right-Click`), Fluid Nozzle Streams & Plumbed Jetpack:**
  * Implement `Right-Click` Vacuum Siphoning (pulls floor puddles or floating `0G` fluid spheres into the player's back-tank along with their `T` and `V` state).
  * Upgrade `Left-Click` (tap for 3-shot fluid burst, hold for pressurized hose stream) and `Space` (jetpack dash expels a 3D trail of the active tank's fluid).
  * *Playtest Gate:* Siphon `Oil` from a broken vat, jetpack-dash over the Alien Dummy to lay an oil trail into a Thermal Vent, and watch the flame propagate across the trail.

* **Milestone 3.2 — Tank Mixing Hazards, Baffled Dual-Tank & Igniter/Coil Attachments:**
  * Implement starter single-tank mixing volatility (including the **Tank Backfire Explosion** when siphoning burning/electrified fluid into a volatile chamber) and the **Baffled Multi-Chamber Tank** with Proportioning Valve (`Chamber A -> Nozzle`, `Chamber B -> Jetpack`).
  * Add the suit attachments (*Spark-Plug Igniter*, *Piezo-Arc Coil*, *Cryo-Expansion Nozzle*, and *`2G/3G` Crush Capacitor*) toggleable via the Debug HUD and Upgrade Workbenches.
  * *Playtest Gate:* Equip the Baffled Tank and attachments to verify self-igniting `Oil` dashes, self-electrified `Water` streams, on-demand `Ice` wall creation, and `2G/3G` gravity slams without relying on room hazards.

### Phase 4: Procedural Xenomorphs & Multi-Room WFC Deck Loop
* **Milestone 4.1 — Procedural Alien Genes (3 Locomotions x 5 Glands x 3 Carapaces) & Bio-Siphoning:**
  * Expand the Base Alien with *Skitterer*, *Floater*, and *Crusher* locomotion AI, the 5 internal fluid glands (*Water*, *Oil*, *Pyro-Napalm*, *Bio-Voltaic Electrolyte*, *Cryo-Coolant*) with `Right-Click` biological siphoning from stunned/wounded aliens, and the 3 armor carapaces (*Thermal Shell*, *Insulated Hide*, *Spined Exoskeleton*).
  * *Playtest Gate:* Spawn each procedural alien combination and verify its elemental counterplay (e.g., siphoning `Cryo-Coolant` from a *Cryo-Spitter* to freeze and `3x` wall-splat a *Thermal Shell* Crusher).

* **Milestone 4.2 — 3D WFC Multi-Room Deck, Airlock Fog-of-War & Full Run Loop:**
  * Implement the 3D Wave Function Collapse deck generator stitching together varied room dimensions (`10x8x32` corridors, `20x12x20` reactor shafts, `32x12x32` cargo bays) with airlock doors, room-by-room fog-of-war, and Upgrade Workbenches.
  * *Playtest Gate:* Complete a full 5-minute multi-room expedition from starter unbaffled tank to upgraded boss fight while maintaining a locked 60 FPS across room transitions.
