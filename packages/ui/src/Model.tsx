// A 3D peek of an STL file: three.js, loaded only when one is shown (FileView lazy-imports this
// module). STL is triangles and nothing else, so parsing it here, as Henry, runs nothing of the
// file's; unlike a PDF it needs no sandboxed frame.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

type View = "iso" | "top" | "front" | "right";
const VIEWS: View[] = ["iso", "top", "front", "right"];
// CAD exports are Z-up. Top is a hair off the pole: looking straight down Z has no "up".
const DIRS: Record<View, [number, number, number]> = { iso: [1, -1, 0.8], top: [0, -1e-3, 1], front: [0, -1, 0], right: [1, 0, 0] };
/** Past this many triangles the feature edges cost more to find than they are worth. */
const EDGES_MAX_TRIS = 500_000;
const FOV = 35;

interface Scene {
  view(v: View): void;
  wire(on: boolean): void;
  edges(on: boolean): void;
}

interface Info {
  tris: number;
  size: [number, number, number];
}

const num = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\.?0+$/, "") || "0";

export function Model({ url, name }: { url: string; name: string }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("iso");
  const [wire, setWire] = useState(false);
  const [edges, setEdges] = useState(true);
  const now = useRef({ view, wire, edges });
  now.current = { view, wire, edges };

  useEffect(() => {
    const el = host.current!;
    setInfo(null);
    setError(null);
    // Transparent, so the peek's own (themed) background is the backdrop.
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    el.appendChild(renderer.domElement);
    const world = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);
    camera.up.set(0, 0, 1);
    world.add(camera);
    const sky = new THREE.HemisphereLight(0xffffff, 0x50505a, 1.4);
    sky.position.set(0, 0, 1);
    world.add(sky);
    // A light riding on the camera: whichever side you turn to is lit.
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(0.6, 0.8, 0);
    key.target.position.set(0, 0, -1);
    camera.add(key, key.target);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.zoomToCursor = true;
    const render = () => renderer.render(world, camera);
    controls.addEventListener("change", render);

    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const disposables: { dispose(): void }[] = [];
    let mesh: THREE.Mesh | null = null;
    let lines: THREE.LineSegments | null = null;
    const center = new THREE.Vector3();
    let radius = 1;

    const look = (v: View) => {
      const dir = new THREE.Vector3(...DIRS[v]).normalize();
      const fitH = radius / Math.sin(THREE.MathUtils.degToRad(FOV / 2));
      const fitW = fitH / Math.min(1, camera.aspect);
      const dist = Math.max(fitH, fitW) * 1.05;
      camera.position.copy(center).addScaledVector(dir, dist);
      camera.near = dist / 1000;
      camera.far = dist * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      render();
    };
    scene.current = {
      view: look,
      wire(on) {
        if (!mesh) return;
        (mesh.material as THREE.MeshStandardMaterial).wireframe = on;
        render();
      },
      edges(on) {
        if (!lines) return;
        lines.visible = on;
        render();
      },
    };

    // Double-click a point on the part to turn about it: the way to look closely at a detail.
    const ray = new THREE.Raycaster();
    const onDbl = (e: MouseEvent) => {
      if (!mesh) return;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObject(mesh)[0];
      if (!hit) return;
      controls.target.copy(hit.point);
      controls.update();
      render();
    };
    renderer.domElement.addEventListener("dblclick", onDbl);

    let gone = false;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`could not read the file (${r.status})`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (gone) return;
        const geo = new STLLoader().parse(buf);
        const tris = (geo.getAttribute("position")?.count ?? 0) / 3;
        if (!tris) throw new Error("No triangles in this file.");
        // Exporters often write zero or wrong normals; the geometry is unindexed, so this gives
        // each face its own true normal.
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
        const box = geo.boundingBox!;
        box.getCenter(center);
        radius = geo.boundingSphere!.radius || 1;
        // The faces sit a hair behind their edges, or the edges flicker through them.
        const mat = new THREE.MeshStandardMaterial({
          color: 0xa3adbb, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
          wireframe: now.current.wire,
        });
        mesh = new THREE.Mesh(geo, mat);
        world.add(mesh);
        disposables.push(geo, mat);
        if (tris <= EDGES_MAX_TRIS) {
          const eg = new THREE.EdgesGeometry(geo, 30);
          const em = new THREE.LineBasicMaterial({ color: 0x1b2027, transparent: true, opacity: 0.55 });
          lines = new THREE.LineSegments(eg, em);
          lines.visible = now.current.edges;
          world.add(lines);
          disposables.push(eg, em);
        }
        // A floor grid under the part, in round steps of its own scale.
        const size = box.getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.y, 1e-6);
        const step = 10 ** Math.floor(Math.log10(span / 2));
        const cells = Math.ceil((span * 1.6) / step / 2) * 2;
        const grid = new THREE.GridHelper(cells * step, cells, 0x8890a0, 0x8890a0);
        grid.rotateX(Math.PI / 2);
        grid.position.set(center.x, center.y, box.min.z);
        (grid.material as THREE.Material).transparent = true;
        (grid.material as THREE.Material).opacity = 0.18;
        world.add(grid);
        disposables.push(grid.geometry, grid.material as THREE.Material);
        setInfo({ tris, size: [size.x, size.y, size.z] });
        look(now.current.view);
      })
      .catch((err: Error) => !gone && setError(err.message || "Could not read this STL."));

    return () => {
      gone = true;
      scene.current = null;
      ro.disconnect();
      renderer.domElement.removeEventListener("dblclick", onDbl);
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      // Browsers keep only a handful of WebGL contexts; give this one back now, not at GC.
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [url]);

  useEffect(() => scene.current?.wire(wire), [wire]);
  useEffect(() => scene.current?.edges(edges), [edges]);

  const pick = (v: View) => {
    setView(v);
    scene.current?.view(v);
  };

  return (
    <div className="model">
      <div className="model-stage" ref={host} title={name} />
      {!info && <div className="peek-note model-note">{error ?? "loading the model…"}</div>}
      {info && (
        <>
          <div className="model-tools">
            <span className="peek-seg" title="look from">
              {VIEWS.map((v) => (
                <button key={v} className={v === view ? "on" : undefined} onClick={() => pick(v)}>{v}</button>
              ))}
            </span>
            <button className={"peek-back" + (edges ? " on" : "")} onClick={() => setEdges((x) => !x)} disabled={info.tris > EDGES_MAX_TRIS}
              title={info.tris > EDGES_MAX_TRIS ? "too many triangles to outline" : "outline the part's edges"}>edges</button>
            <button className={"peek-back" + (wire ? " on" : "")} onClick={() => setWire((x) => !x)} title="show the triangles">wire</button>
          </div>
          <div className="model-info" title="width × depth × height, in the file's units (STL has none; millimetres are usual)">
            {info.tris.toLocaleString()} triangles · {info.size.map(num).join(" × ")}
          </div>
          <div className="model-hint">drag turns · right-drag pans · scroll zooms · double-click turns about a point</div>
        </>
      )}
    </div>
  );
}
