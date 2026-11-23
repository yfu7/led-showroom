import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildExportRoot, INCH_TO_METRE } from './gltf';
import { buildViewerHtml, bytesToBase64, dimSetOf, lightDir, scriptSafeJson, suggestViewerFilename, utf8ToBase64 } from './viewer';
import type { ViewerConfig } from '@/viewer/config';

const config = (over: Partial<ViewerConfig> = {}): ViewerConfig => ({
  v: 1, title: 'Show', exportedAt: '2026-11-23T00:00:00.000Z', appVersion: '2.4.0', fovDeg: 40, shadows: true,
  lights: [{ kind: 'ambient', color: '#ffffff', intensity: 0.3 }],
  floor: { visible: true, color: '#0d1218', sizeM: 36.576, shadowCatcher: false },
  backdrop: 'radial-gradient(ellipse at 50% 65%, #16202b 0%, #05070a 70%)',
  presets: [], start: { position: [0, 1.6, 5], target: [0, 1, 0] },
  bounds: { min: [-1, 0, -1], max: [1, 2, 1] }, glbBytes: 4, dims: [], ...over,
});

/** The text of the script element with this id. */
const scriptText = (html: string, id: string): string => {
  const m = new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error(`no #${id}`);
  return m[1];
};
const bytesOf = (b64: string): Uint8Array => Uint8Array.from(atob(b64.replace(/\s+/g, '')), c => c.charCodeAt(0));
const fromBase64 = (b64: string): string => new TextDecoder().decode(bytesOf(b64));

describe('viewer page', () => {
  // Minified three holds both of these in its code; neither may end or bend a script element.
  const runtime = 'var a="</script><script>alert(1)</script>";var b=1<!--2;/* <!-- */ console.log("ünïcode ✓")';
  const hostile = '</script><img src=x onerror=alert(1)> & "quotes" <!--';

  it('carries the runtime so that no text in it can end its script element', () => {
    const html = buildViewerHtml({ config: config(), glbBase64: bytesToBase64(new Uint8Array([103, 108, 84, 70])), runtime });
    // The only script closers are the page's own four.
    expect(html.match(/<\/script/gi)).toHaveLength(4);
    expect(html).not.toContain('<!--');
    expect(fromBase64(scriptText(html, 'viewer-runtime'))).toBe(runtime);
    expect(scriptText(html, 'viewer-glb').replace(/\s+/g, '')).toBe(btoa('glTF'));
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });

  it('escapes the title and every string in the config', () => {
    const html = buildViewerHtml({
      config: config({ title: hostile, presets: [{ id: 'wall:1', label: hostile, center: [0, 0, 0], w: 1, h: 1, depth: 0, dir: [0, 0, 1] }] }),
      glbBase64: '', runtime: '',
    });
    expect(html.match(/<\/script/gi)).toHaveLength(4);
    expect(html).toContain('<title>&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot; &lt;!--</title>');
    const back = JSON.parse(scriptText(html, 'viewer-config')) as ViewerConfig;
    expect(back.title).toBe(hostile);
    expect(back.presets[0].label).toBe(hostile);
  });

  it('keeps every line short enough for mail, and the model whole', () => {
    const big = new Uint8Array(200_000).map((_, i) => (i * 7) & 255);
    const html = buildViewerHtml({ config: config(), glbBase64: bytesToBase64(big), runtime: 'x'.repeat(50_000) });
    const longest = Math.max(...html.split('\n').map(l => l.length));
    expect(longest).toBeLessThan(2000);
    expect(bytesOf(scriptText(html, 'viewer-glb'))).toEqual(big);
  });

  it('round-trips UTF-8 and line separators', () => {
    expect(fromBase64(utf8ToBase64('ünï ✓  '))).toBe('ünï ✓  ');
    expect(JSON.parse(scriptSafeJson({ s: 'a b</x>' }))).toEqual({ s: 'a b</x>' });
    expect(scriptSafeJson({ s: '</x>' })).not.toContain('<');
  });

  it('aims each light from its position to its own target, not the scene middle', () => {
    const fill = new THREE.DirectionalLight();
    fill.position.set(-3, 4, 0); // target left at the origin, as the app leaves fill and rim
    expect(lightDir(fill).map(v => +v.toFixed(6))).toEqual([-0.6, 0.8, 0]);
    const key = new THREE.DirectionalLight();
    key.position.set(10, 10, 5);
    key.target.position.set(10, 6, 2);
    expect(lightDir(key).map(v => +v.toFixed(6))).toEqual([0, 0.8, 0.6]);
  });

  it('carries an empty model when the scene is empty', () => {
    const html = buildViewerHtml({ config: config({ glbBytes: 0 }), glbBase64: bytesToBase64(new Uint8Array(0)), runtime: 'void 0' });
    expect(bytesOf(scriptText(html, 'viewer-glb')).length).toBe(0);
  });

  it('names the file after the scene', () => {
    expect(suggestViewerFilename('Main Stage / North')).toBe('main-stage-north-viewer.html');
    expect(suggestViewerFilename('')).toBe('showroom-viewer.html');
  });

  it('frames the walls where the GLB puts them: the export only scales world inches to metres', () => {
    // A wall turned to face +x, stood off the origin, under a parent group: as the app nests them.
    const parent = new THREE.Group();
    parent.position.set(40, 0, -12);
    const wall = new THREE.Group();
    wall.name = 'wall';
    wall.position.set(100, 0, 30);
    wall.rotation.y = Math.PI / 2;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(120, 96, 4));
    panel.position.y = 48;
    wall.add(panel);
    parent.add(wall);
    const world = new THREE.Group();
    world.add(parent);
    world.updateMatrixWorld(true);

    const inches = new THREE.Box3().setFromObject(wall);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(wall.getWorldQuaternion(new THREE.Quaternion()));

    const root = buildExportRoot([parent]);
    const exported = root.getObjectByName('wall')!;
    const metres = new THREE.Box3().setFromObject(exported);
    for (const k of ['min', 'max'] as const) {
      const a = metres[k].clone().divideScalar(INCH_TO_METRE), b = inches[k];
      expect(a.distanceTo(b)).toBeLessThan(1e-6);
    }
    const n2 = new THREE.Vector3(0, 0, 1).applyQuaternion(exported.getWorldQuaternion(new THREE.Quaternion()));
    expect(n2.distanceTo(normal)).toBeLessThan(1e-9);
    expect(normal.x).toBeCloseTo(1, 9);
  });
});

describe('viewer dimensions', () => {
  it('carries a set in metres to a tenth of a millimetre, and nothing when empty', () => {
    expect(dimSetOf('wall', '#00bbff', '#00ccff', { segs: [], labels: [] })).toBeNull();
    const s = dimSetOf('wall', '#00bbff', '#00ccff', {
      segs: [0, 0, 0, 100, 48, -1 / 3],
      labels: [{ text: '100"', p: [50, -4, 1.15], h: 6 }],
    })!;
    expect(s.segs).toEqual([0, 0, 0, 2.54, 1.2192, -0.0085]);
    expect(s.labels).toEqual([{ text: '100"', p: [1.27, -0.1016, 0.0292], h: 0.1524 }]);
    expect(s.kind).toBe('wall');
    const d = dimSetOf('measure', '#eab308', '#00ccff', { segs: [0, 0, 0, 1, 0, 0], labels: [] }, { dashed: true, opacity: 0.3 })!;
    expect([d.dashed, d.opacity]).toEqual([true, 0.3]);
  });

  it('lets the page carry label text safely', () => {
    const html = buildViewerHtml({
      config: config({ dims: [{ kind: 'measure', line: '#eab308', text: '#00ccff', segs: [], labels: [{ text: '</script><!--', p: [0, 0, 0], h: 0.15 }] }] }),
      glbBase64: '', runtime: '',
    });
    expect(scriptText(html, 'viewer-config')).not.toContain('</script');
    expect(JSON.parse(scriptText(html, 'viewer-config')).dims[0].labels[0].text).toBe('</script><!--');
  });
});
