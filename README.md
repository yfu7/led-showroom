# LED Showroom

**The app is [`led-showroom-v2/`](led-showroom-v2/).** Start there. `master` is the v2 line.

```bash
cd led-showroom-v2
npm install
npm run dev
```

See [led-showroom-v2/README.md](led-showroom-v2/README.md) for how to run it,
[ARCHITECTURE.md](led-showroom-v2/ARCHITECTURE.md) for how it is put together, and
[CHANGELOG.md](led-showroom-v2/CHANGELOG.md) for what shipped in 2.0.0.

Live at https://led-showroom-v2.vercel.app.

## Layout

| path | what it is |
| --- | --- |
| `led-showroom-v2/` | Veloxity Showroom, the current app. All work happens here. |
| `cad/` | The manufacturer's SolidWorks STEP and PDF drawings. `npm run cad` in v2 converts them to the glTF meshes it renders, so they are the source of truth for the LED iPoster's real dimensions. |
| `index.html`, `server.js` | v1, deprecated. Kept as a historical artifact only. |

## v1 is deprecated

v1 was a single 9,560-line `index.html` with a small Node server. v2 replaces it entirely and
carried over every practical capability, audited against a 108-item checklist. Nothing new goes
into v1.

Its files stay in the repository for reference, but everything it exposed to the network is closed:

- Its Vercel project has been deleted, so `led-showroom.vercel.app` no longer serves anything.
- Its serverless proxy (`api/proxy.js`) and the rewrite that published it (`vercel.json`) are gone.
- The `/proxy` route in `server.js` now answers 410 and makes no outbound request.

That proxy fetched whatever URL a caller named, validating nothing but the scheme and returning the
response with `Access-Control-Allow-Origin: *`. Deployed, it was an open proxy: anyone could reach
private addresses from inside the hosting network, and any website's JavaScript could read what came
back. It is closed rather than repaired, because v1 is not maintained. v2 has a guarded
implementation in `led-showroom-v2/server/urlGuard.cjs`, which resolves the host, rejects every
non-public address, and pins the connection to the address it validated.

If you run `server.js` at all, note that it still serves v1's `index.html` and its splat endpoints
on your own machine. It is not deployed anywhere.
