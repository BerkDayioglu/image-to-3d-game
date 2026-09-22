// Three.js viewer: inspect mode (orbit, look-dev lights, explode, parts) and a small game test mode.
// It uses the helper functions emitted by img2threejs' generate_threejs_factory.py for the model,
// look-dev lights, environment, renderer config and camera framing.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.background = new THREE.Color('#1b1e24');
    this.scene.background = this.background;
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 200);
    this.camera.position.set(2.2, 1.6, 3.2);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotateSpeed = 1.2;

    this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(12, 64),
      new THREE.ShadowMaterial({ opacity: 0.35 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.grid = new THREE.GridHelper(12, 48, 0x3a4050, 0x2a2f3a);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.5;
    this.scene.add(this.grid);

    this.fallbackLights = new THREE.Group();
    this.fallbackLights.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(-3, 6, 4);
    sun.castShadow = true;
    this.fallbackLights.add(sun);
    this.scene.add(this.fallbackLights);

    this.placement = new THREE.Group();
    this.scene.add(this.placement);
    this.model = null;
    this.module = null;
    this.exportsInfo = null;
    this.lights = null;
    this.lightMode = 'neutral';
    this.explode = 0;
    this.clock = new THREE.Clock();
    this.game = null;
    this.onFrame = null;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get hasModel() {
    return Boolean(this.model);
  }

  /** Mount a model produced by the generated factory module. */
  mount(mod, exportsInfo) {
    this.unmount();
    this.module = mod;
    this.exportsInfo = exportsInfo;
    const create = mod[exportsInfo.model];
    if (typeof create !== 'function') throw new Error(`Factory ${exportsInfo.model} bulunamadı`);
    const model = create({ castShadow: true, receiveShadow: true });
    this.model = model;

    // Rest on the ground, centred on the origin.
    this.placement.position.set(0, 0, 0);
    this.placement.add(model);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    if (!box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3());
      this.placement.position.set(-center.x, -box.min.y, -center.z);
    }
    this.size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
    this.recordExplodeOrigins();

    try {
      mod[exportsInfo.renderer]?.(this.renderer);
    } catch (e) {
      console.warn(e);
    }
    try {
      this.scene.environment = mod[exportsInfo.environment]?.(this.renderer) ?? null;
    } catch (e) {
      console.warn(e);
    }
    this.setLightMode(this.lightMode);
    this.frameCamera();
    return this.stats();
  }

  unmount() {
    if (this.model) {
      this.placement.remove(this.model);
      this.model.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
    }
    if (this.lights) this.scene.remove(this.lights);
    this.model = null;
    this.lights = null;
  }

  setLightMode(mode) {
    this.lightMode = mode;
    if (this.lights) this.scene.remove(this.lights);
    this.lights = null;
    const make = this.module && this.exportsInfo && this.module[this.exportsInfo.lights];
    if (typeof make === 'function') {
      this.lights = make(mode);
      this.scene.add(this.lights);
      this.fallbackLights.visible = false;
    } else {
      this.fallbackLights.visible = true;
    }
  }

  frameCamera(azimuthDeg = 30, elevationDeg = 18) {
    if (!this.model) return;
    const target = new THREE.Box3().setFromObject(this.model);
    const center = target.getCenter(new THREE.Vector3());
    const radius = target.getBoundingSphere(new THREE.Sphere()).radius || 0.5;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const fov = Math.min(vfov, hfov);
    const dist = (radius / Math.sin(fov / 2)) * 1.05;
    const az = (azimuthDeg * Math.PI) / 180;
    const el = (elevationDeg * Math.PI) / 180;
    this.camera.position.set(
      center.x + dist * Math.cos(el) * Math.sin(az),
      center.y + dist * Math.sin(el),
      center.z + dist * Math.cos(el) * Math.cos(az),
    );
    this.camera.near = Math.max(0.001, dist / 100);
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.minDistance = radius * 0.3;
    this.controls.maxDistance = dist * 6;
    this.controls.update();
  }

  setAutoRotate(on) {
    this.controls.autoRotate = on;
  }

  setWireframe(on) {
    this.model?.traverse((o) => {
      if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => (m.wireframe = on));
    });
  }

  setGrid(on) {
    this.grid.visible = on;
  }

  setBackground(color) {
    this.background.set(color);
  }

  /** Component nodes emitted by the factory (pivot groups named "<name>__pivot"). */
  parts() {
    const out = [];
    this.model?.traverse((o) => {
      if (o.isGroup && o.name.endsWith('__pivot')) {
        out.push({ name: o.name.replace(/__pivot$/, ''), object: o, level: o.userData.sculptComponent?.level || '' });
      }
    });
    return out;
  }

  recordExplodeOrigins() {
    this.parts().forEach(({ object }) => {
      object.userData.__origin = object.position.clone();
    });
  }

  setExplode(amount) {
    this.explode = amount;
    if (!this.model) return;
    const center = new THREE.Box3().setFromObject(this.model).getCenter(new THREE.Vector3());
    this.parts().forEach(({ object }) => {
      const origin = object.userData.__origin;
      if (!origin) return;
      object.position.copy(origin);
      if (amount <= 0 || !object.parent || object.parent === this.model) {
        if (amount > 0 && object.parent === this.model) {
          const world = object.getWorldPosition(new THREE.Vector3());
          const dir = world.sub(center);
          if (dir.lengthSq() > 1e-8) object.position.add(dir.normalize().multiplyScalar(amount * 0.6));
        }
        return;
      }
      const dir = origin.clone();
      if (dir.lengthSq() > 1e-8) object.position.add(dir.normalize().multiplyScalar(amount * 0.35));
    });
  }

  stats() {
    let meshes = 0;
    let triangles = 0;
    const materials = new Set();
    this.model?.traverse((o) => {
      if (!o.isMesh) return;
      meshes += 1;
      const g = o.geometry;
      const count = g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
      triangles += count * (o.isInstancedMesh ? o.count : 1);
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => materials.add(m.uuid));
    });
    return { meshes, triangles: Math.round(triangles), materials: materials.size, parts: this.parts().length };
  }

  /** Render fixed review views (used by the Divine Eye review round). */
  captureViews(views, { size = 640, format = 'image/jpeg', mapStripped = false } = {}) {
    const prev = {
      pos: this.camera.position.clone(),
      target: this.controls.target.clone(),
      aspect: this.camera.aspect,
      auto: this.controls.autoRotate,
      grid: this.grid.visible,
      override: this.scene.overrideMaterial,
      background: this.scene.background,
    };
    // img2threejs "map-stripped" evidence: unlit, untextured, so only form and silhouette are judged.
    const flat = mapStripped ? new THREE.MeshBasicMaterial({ color: 0x8c8c8c }) : null;
    if (flat) {
      this.scene.overrideMaterial = flat;
      this.scene.background = new THREE.Color('#f2f2f2');
    }
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.controls.autoRotate = false;
    this.grid.visible = false;
    this.renderer.setSize(size, size, false);
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
    const shots = views.map(({ azimuth, elevation }) => {
      this.frameCamera(azimuth, elevation);
      this.renderer.render(this.scene, this.camera);
      return this.renderer.domElement.toDataURL(format, 0.88);
    });
    this.scene.overrideMaterial = prev.override;
    this.scene.background = prev.background;
    flat?.dispose();
    this.renderer.setSize(w, h, false);
    this.camera.aspect = prev.aspect;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(prev.pos);
    this.controls.target.copy(prev.target);
    this.controls.autoRotate = prev.auto;
    this.grid.visible = prev.grid;
    this.controls.update();
    return shots;
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const tick = this.model?.userData?.tick;
    if (typeof tick === 'function') {
      try {
        tick(dt, this.clock.elapsedTime);
      } catch {
        /* animation hooks are optional */
      }
    }
    if (this.game) this.game.update(dt);
    else this.controls.update();
    this.onFrame?.(dt);
    this.renderer.render(this.scene, this.camera);
  }
}
