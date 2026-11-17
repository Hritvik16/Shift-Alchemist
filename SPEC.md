# Shift Alchemist — 3D Thermodynamic & Amalgamation Architecture

## 1. Core Design Pillars
* **Zero-HUD Diegetic Design:** Mass = Health = Physical 3D Radius. Absorbed periodic elements visibly tint and streak the player's liquid-chrome shader and scale Solid/Liquid/Gas combat physics.
* **Voronoi Metastable World:** Continuous 2.5D/3D terrain partitioned into Voronoi basins. Each basin has a single Dominant Element, Ambient Temperature ($T$), and Ambient Pressure ($P$). Neighboring basins are generated with high thermodynamic contrast ($\Delta T, \Delta P$) separated by destructible crust ridges.
* **Phase-Mutating Procedural Entities:** Every enemy is an elemental nucleus defined by its Periodic Table entry ($Z, T_m, T_b$, Density, Volatility, Conductivity). Its AI, 3D mesh, and attack patterns automatically mutate when kited across basin borders into a new state of matter (Solid Polyhedron, Liquid Predator, or Gas Vortex).
* **Self-Swap & Phase-Shift Combat:**
  - **Liquid (Default):** High-speed skating; dashing through metallic/reactive elements dissolves them into your Amalgam inventory.
  - **Solid (Left-Click — Ferrofluid Spike Cleave):** Flash-freezes into Rosensweig magnetic spikes that shatter brittle crust dams and solid enemies.
  - **Gas (Space — Vapor Precipitation):** Flash-boils into an untargetable plasma cloud; all dissolved metals violently precipitate outward as a 360-degree shrapnel storm.
  - **Droplet Swap (Right-Click):** Detaches a physical Mercury Orb (costing 15% mass) or swaps your position and velocity vector with the active Orb.

## 2. Strict Separation
* `src/core/`: Pure TypeScript simulation, Voronoi basin generator, thermodynamic phase solver, fluid/crust cellular grid, and entity physics. Zero Three.js or DOM imports.
* `src/viewer/`: Three.js 45-degree angled top-down 3D renderer, dynamic terrain heightfield + fluid mesh, instanced Rosensweig ferrofluid spikes, and procedural elemental geometry.
