// Game test mode: drop the reconstructed model into a small arena as a playable object.
// WASD / arrows move (camera-relative), Space jumps, Shift sprints, Q/E spin, drag to orbit.
import * as THREE from 'three';

const GRAVITY = -22;
const PLAYER_SIZE = 1.3; // model is normalised to this largest dimension in game mode

function checkerTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      g.fillStyle = (x + y) % 2 ? '#2b313c' : '#323a47';
      g.fillRect(x * 32, y * 32, 32, 32);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(12, 12);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class GameMode {
  constructor(viewer, hud) {
    this.viewer = viewer;
    this.hud = hud;
    this.keys = new Set();
    this.velocity = new THREE.Vector3();
    this.onGround = true;
    this.score = 0;
    this.arena = new THREE.Group();
    this.obstacles = [];
    this.coins = [];
    this.onKeyDown = (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
    };
    this.onKeyUp = (e) => this.keys.delete(e.code);
  }

  buildArena() {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(48, 48),
      new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.arena.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({ color: '#46506a', roughness: 0.7 });
    const blocks = [
      [4, 0.6, -3, 2, 1.2, 2],
      [-5, 0.4, 2, 3, 0.8, 1.5],
      [0, 1, -8, 6, 2, 1],
      [7, 1.5, 5, 1.5, 3, 1.5],
      [-7, 0.75, -6, 2, 1.5, 2],
      [-2, 0.3, 6, 2.5, 0.6, 2.5],
    ];
    blocks.forEach(([x, y, z, w, h, d]) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
      m.position.set(x, y, z);
      m.castShadow = m.receiveShadow = true;
      this.arena.add(m);
      this.obstacles.push(new THREE.Box3().setFromObject(m));
    });
    const border = new THREE.Mesh(
      new THREE.TorusGeometry(15, 0.25, 8, 96),
      new THREE.MeshStandardMaterial({ color: '#7c5cff', emissive: '#3a2a99', emissiveIntensity: 0.6 }),
    );
    border.rotation.x = Math.PI / 2;
    border.position.y = 0.05;
    this.arena.add(border);

    const coinGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.06, 24);
    const coinMat = new THREE.MeshStandardMaterial({ color: '#ffcc33', metalness: 0.9, roughness: 0.25, emissive: '#553300' });
    for (let i = 0; i < 10; i += 1) {
      const coin = new THREE.Mesh(coinGeo, coinMat);
      const a = (i / 10) * Math.PI * 2;
      const r = 4 + (i % 3) * 3;
      coin.position.set(Math.cos(a) * r, 0.7, Math.sin(a) * r);
      coin.rotation.x = Math.PI / 2;
      coin.castShadow = true;
      this.arena.add(coin);
      this.coins.push(coin);
    }
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(8, 14, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 50 });
    this.arena.add(sun);
    this.arena.add(new THREE.HemisphereLight(0xcfe0ff, 0x30303a, 0.8));
  }

  start() {
    const v = this.viewer;
    if (!v.model) return false;
    this.buildArena();
    v.scene.add(this.arena);
    v.grid.visible = false;
    v.ground.visible = false;

    // Normalise the model to a playable size and remember the inspect transform.
    this.saved = {
      placementPos: v.placement.position.clone(),
      placementScale: v.placement.scale.clone(),
      placementRot: v.placement.rotation.clone(),
      camera: v.camera.position.clone(),
      target: v.controls.target.clone(),
      auto: v.controls.autoRotate,
      grid: v.grid.visible,
    };
    this.player = new THREE.Group();
    v.scene.add(this.player);
    v.scene.remove(v.placement);
    this.player.add(v.placement);
    const size = v.size || new THREE.Vector3(1, 1, 1);
    const k = PLAYER_SIZE / Math.max(size.x, size.y, size.z, 0.001);
    v.placement.scale.setScalar(k);
    v.placement.position.multiplyScalar(k);
    this.halfExtents = new THREE.Vector3(size.x * k * 0.5, size.y * k, size.z * k * 0.5);
    this.player.position.set(0, 0, 3);
    this.velocity.set(0, 0, 0);
    this.score = 0;
    v.controls.autoRotate = false;
    v.controls.enablePan = false;
    v.controls.target.copy(this.player.position).add(new THREE.Vector3(0, this.halfExtents.y * 0.6, 0));
    v.camera.position.copy(v.controls.target).add(new THREE.Vector3(0, 2.5, 5.5));
    v.controls.minDistance = 2;
    v.controls.maxDistance = 14;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    v.game = this;
    this.updateHud();
    return true;
  }

  stop() {
    const v = this.viewer;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.keys.clear();
    v.game = null;
    if (this.player) {
      this.player.remove(v.placement);
      v.scene.remove(this.player);
      v.scene.add(v.placement);
    }
    if (this.saved) {
      v.placement.position.copy(this.saved.placementPos);
      v.placement.scale.copy(this.saved.placementScale);
      v.placement.rotation.copy(this.saved.placementRot);
      v.camera.position.copy(this.saved.camera);
      v.controls.target.copy(this.saved.target);
      v.controls.autoRotate = this.saved.auto;
      v.grid.visible = this.saved.grid;
    }
    v.ground.visible = true;
    v.controls.enablePan = true;
    v.scene.remove(this.arena);
    this.arena.traverse((o) => o.geometry?.dispose());
    this.arena = new THREE.Group();
    this.obstacles = [];
    this.coins = [];
    v.frameCamera();
  }

  pressVirtual(code, down) {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  updateHud() {
    this.hud?.({ score: this.score, total: 10 });
  }

  collide(next) {
    const he = this.halfExtents;
    const box = new THREE.Box3(
      new THREE.Vector3(next.x - he.x, next.y, next.z - he.z),
      new THREE.Vector3(next.x + he.x, next.y + he.y, next.z + he.z),
    );
    for (const ob of this.obstacles) {
      if (!box.intersectsBox(ob)) continue;
      const prevY = this.player.position.y;
      if (prevY >= ob.max.y - 0.05 && this.velocity.y <= 0) {
        next.y = ob.max.y;
        this.velocity.y = 0;
        this.onGround = true;
        continue;
      }
      // push out along the shallowest horizontal axis
      const dx1 = ob.max.x - box.min.x;
      const dx2 = box.max.x - ob.min.x;
      const dz1 = ob.max.z - box.min.z;
      const dz2 = box.max.z - ob.min.z;
      const m = Math.min(dx1, dx2, dz1, dz2);
      if (m === dx1) next.x += dx1;
      else if (m === dx2) next.x -= dx2;
      else if (m === dz1) next.z += dz1;
      else next.z -= dz2;
    }
    return next;
  }

  update(dt) {
    const v = this.viewer;
    const k = this.keys;
    const forward = new THREE.Vector3();
    v.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const move = new THREE.Vector3();
    if (k.has('KeyW') || k.has('ArrowUp')) move.add(forward);
    if (k.has('KeyS') || k.has('ArrowDown')) move.sub(forward);
    if (k.has('KeyD') || k.has('ArrowRight')) move.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) move.sub(right);
    const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? 8 : 4.5;
    if (move.lengthSq() > 0) {
      move.normalize();
      const targetYaw = Math.atan2(move.x, move.z);
      let delta = targetYaw - this.player.rotation.y;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.player.rotation.y += delta * Math.min(1, dt * 10);
    }
    if (k.has('KeyQ')) this.player.rotation.y += dt * 3;
    if (k.has('KeyE')) this.player.rotation.y -= dt * 3;
    this.velocity.x = move.x * speed;
    this.velocity.z = move.z * speed;
    if (k.has('Space') && this.onGround) {
      this.velocity.y = 8.5;
      this.onGround = false;
    }
    this.velocity.y += GRAVITY * dt;

    const next = this.player.position.clone().addScaledVector(this.velocity, dt);
    this.onGround = false;
    if (next.y <= 0) {
      next.y = 0;
      this.velocity.y = 0;
      this.onGround = true;
    }
    this.collide(next);
    const r = Math.hypot(next.x, next.z);
    if (r > 14.2) {
      next.x *= 14.2 / r;
      next.z *= 14.2 / r;
    }
    const moved = next.clone().sub(this.player.position);
    this.player.position.copy(next);
    // a little squash & bob so the object reads as "alive"
    const airborne = !this.onGround;
    const s = airborne ? 1.04 : 1 + Math.sin(performance.now() / 90) * 0.015 * (move.lengthSq() > 0 ? 1 : 0);
    this.player.scale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s));

    this.coins.forEach((coin) => {
      if (!coin.visible) return;
      coin.rotation.z += dt * 3;
      if (coin.position.distanceTo(this.player.position.clone().setY(coin.position.y)) < 0.4 + this.halfExtents.x) {
        coin.visible = false;
        this.score += 1;
        this.updateHud();
      }
    });

    v.camera.position.add(moved);
    v.controls.target.copy(this.player.position).add(new THREE.Vector3(0, this.halfExtents.y * 0.6, 0));
    v.controls.update();
  }
}
