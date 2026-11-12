// ---------- constants ----------
const SCALE = 0.0254;         // Source engine units -> meters
const EYE_HEIGHT = 1.72;
const MOVE_SPEED = 4.6;        // m/s
const PLAYER_RADIUS = 0.35;
const ZEUS_CLIENT_RANGE = 3.0; 
const ZEUS_COOLDOWN_MS = 1100;

// ---------- DOM ----------
const el = (id) => document.getElementById(id);
const menuEl = el('menu'), hudEl = el('hud');
const statusEl = el('menuStatus'), waitOverlay = el('waitOverlay'), waitCount = el('waitCount');
const healthBar = el('healthBar'), healthText = el('healthText');
const roomBadge = el('roomBadge'), scoreBadge = el('scoreBadge'), killfeedEl = el('killfeed');
const centerMsg = el('centerMsg'), scoreboardEl = el('scoreboard');

let selectedMode = 'ffa';
document.querySelectorAll('.modeBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.modeBtn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedMode = btn.dataset.mode;
    joinGame({ mode: selectedMode });
  });
});
el('createPrivateBtn').addEventListener('click', () => joinGame({ mode: selectedMode, createPrivate: true }));
el('joinCodeBtn').addEventListener('click', () => {
  const code = el('codeInput').value.trim().toUpperCase();
  if (!code) { statusEl.textContent = 'Введіть код кімнати'; return; }
  joinGame({ roomCode: code });
});

// ---------- networking ----------
let ws = null;
let myId = null, myTeam = null, roomMode = null, roomCode = null;
const remotePlayers = new Map();

function wsUrl() {
  const custom = el('serverInput') ? el('serverInput').value.trim() : '';
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  if (!custom) return proto + location.host;
  if (custom.startsWith('ws://') || custom.startsWith('wss://')) return custom;
  return proto + custom;
}

function joinGame(opts) {
  statusEl.textContent = 'Підключення…';
  try {
    ws = new WebSocket(wsUrl());
  } catch (e) {
    statusEl.textContent = 'Не вдалось підключитись до сервера';
    return;
  }
  ws.onopen = () => {
    ws.send(JSON.stringify({
      t: 'join',
      mode: opts.mode,
      roomCode: opts.roomCode,
      createPrivate: !!opts.createPrivate,
      name: el('nameInput').value.trim() || 'Player'
    }));
  };
  ws.onclose = () => { statusEl.textContent = 'З\'єднання розірвано'; };
  ws.onerror = () => { statusEl.textContent = 'Помилка з\'єднання'; };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
}

function onMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      myId = msg.id; myTeam = msg.team; roomMode = msg.mode; roomCode = msg.roomCode;
      roomBadge.textContent = `Кімната ${roomCode} · ${roomMode.toUpperCase()}${myTeam ? ' · Команда ' + myTeam : ''}`;
      if (msg.waiting) {
        waitOverlay.classList.remove('hidden');
        waitCount.textContent = '';
      }
      break;
    case 'roomInfo':
      if (waitOverlay && !waitOverlay.classList.contains('hidden')) {
        const need = msg.mode === 'ffa' ? 2 : capacityOf(msg.mode);
        waitCount.textContent = `(${msg.players.length}/${need})`;
      }
      break;
    case 'start':
      waitOverlay.classList.add('hidden');
      enterWorld();
      respawnAt(msg.zone);
      break;
    case 'respawn':
      respawnAt(msg.zone);
      break;
    case 'death':
      showCenter(`Вас вбив ${msg.by}`, 1400);
      break;
    case 'state':
      applyState(msg.players);
      break;
    case 'killfeed':
      addKillfeed(msg.killer, msg.victim);
      break;
    case 'score':
      scoreBadge.textContent = `${msg.scores.A || 0} : ${msg.scores.B || 0}`;
      break;
    case 'end':
      showScoreboard(msg);
      break;
    case 'leave':
      removeRemote(msg.id);
      break;
    case 'error':
      statusEl.textContent = msg.msg;
      break;
  }
}

function capacityOf(mode) {
  return { ffa: 8, '1v1': 2, '2v2': 4, '3v3': 6, '4v4': 8 }[mode] || 2;
}

function addKillfeed(killer, victim) {
  const d = document.createElement('div');
  d.textContent = `${killer}  ⚡  ${victim}`;
  killfeedEl.appendChild(d);
  setTimeout(() => d.remove(), 4000);
}

function showCenter(text, ms) {
  centerMsg.textContent = text;
  clearTimeout(showCenter._t);
  showCenter._t = setTimeout(() => { centerMsg.textContent = ''; }, ms);
}

function showScoreboard(msg) {
  document.exitPointerLock && document.exitPointerLock();
  scoreboardEl.classList.remove('hidden');
  scoreboardEl.innerHTML = `
    <div style="text-align:center">
      <h2>Перемогла команда ${msg.winner}</h2>
      <p>${msg.scores.A || 0} : ${msg.scores.B || 0}</p>
      <button onclick="location.reload()" style="padding:10px 20px;border-radius:8px;border:1px solid #39404f;background:#ffb020;cursor:pointer;">До меню</button>
    </div>`;
}

// ---------- three.js scene ----------
let renderer, scene, camera, mapGroup = null;
let mapMeshes = [];
let clock = new THREE.Clock();
let zeusModel = null, zeusMixer = null, zeusActions = {};
let agentTemplate = null;
let myAvatar = null; // Власна модель для вигляду від 3-ї особи
let thirdPerson = false; // Перемикач режиму камери (F3)

const raycaster = new THREE.Raycaster();
const downRay = new THREE.Raycaster();

let yaw = 0, pitch = 0;
let playerPos = new THREE.Vector3(0, 5, 0);
let lastAttackLocal = 0;
let keys = {};
let worldReady = false, pointerLocked = false;

function initScene() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = false;
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc2e0);
  scene.fog = new THREE.Fog(0x9fc2e0, 40, 170);

  camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 500);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d6, 1.4);
  sun.position.set(60, 90, 40);
  scene.add(sun);

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  loadMap();
  loadZeus();
  loadAgentTemplate();

  renderer.domElement.addEventListener('click', () => {
    if (worldReady) renderer.domElement.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === renderer.domElement;
  });
  document.addEventListener('mousemove', (e) => {
    if (!pointerLocked) return;
    yaw -= e.movementX * 0.0022;
    pitch -= e.movementY * 0.0022;
    pitch = Math.max(-1.3, Math.min(1.3, pitch));
  });
  document.addEventListener('mousedown', (e) => {
    if (pointerLocked && e.button === 0) tryAttack();
  });
  
  document.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    // Перемикач вигляду від 3-ї особи на клавішу F3
    if (e.code === 'F3') {
      e.preventDefault();
      thirdPerson = !thirdPerson;
      if (myAvatar) myAvatar.visible = thirdPerson;
      if (zeusModel) zeusModel.visible = !thirdPerson;
    }
  });
  document.addEventListener('keyup', (e) => keys[e.code] = false);

  renderer.setAnimationLoop(tick);
}

function loadMap() {
  const mtlLoader = new THREE.MTLLoader();
  mtlLoader.setPath('assets/map/');
  mtlLoader.setResourcePath('assets/map/textures/');
  mtlLoader.load('de_dust2.mtl', (materials) => {
    materials.preload();
    for (const key in materials.materials) {
      materials.materials[key].side = THREE.DoubleSide;
    }
    const objLoader = new THREE.OBJLoader();
    objLoader.setMaterials(materials);
    objLoader.setPath('assets/map/');
    objLoader.load('de_dust2.obj', (obj) => {
      obj.rotation.x = -Math.PI / 2;
      obj.scale.setScalar(SCALE);
      obj.traverse((c) => { if (c.isMesh) mapMeshes.push(c); });
      mapGroup = obj;
      scene.add(obj);
    }, undefined, (err) => console.error('map load error', err));
  }, undefined, (err) => console.error('mtl load error', err));
}

function loadZeus() {
  new THREE.GLTFLoader().load('assets/models/zeus.glb', (gltf) => {
    zeusModel = gltf.scene;
    const box = new THREE.Box3().setFromObject(zeusModel);
    const size = new THREE.Vector3(); box.getSize(size);
    const targetLen = 0.26;
    const s = targetLen / Math.max(size.x, size.y, size.z);
    zeusModel.scale.setScalar(s);
    zeusModel.position.set(0.22, -0.22, -0.4);
    zeusModel.rotation.set(0, Math.PI, 0);
    camera.add(zeusModel);
    if (gltf.animations && gltf.animations.length) {
      zeusMixer = new THREE.AnimationMixer(zeusModel);
      for (const clip of gltf.animations) zeusActions[clip.name] = zeusMixer.clipAction(clip);
      if (zeusActions['firstperson_idle']) zeusActions['firstperson_idle'].play();
    }
  }, undefined, (err) => console.error('zeus load error', err));
}

function loadAgentTemplate() {
  new THREE.GLTFLoader().load('assets/models/agent.gltf', (gltf) => {
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(); box.getSize(size);
    const targetHeight = 1.8;
    const s = targetHeight / Math.max(size.y, 0.01);
    model.scale.setScalar(s);
    const box2 = new THREE.Box3().setFromObject(model);
    model.position.y -= box2.min.y;
    agentTemplate = model;

    // Створюємо власну модель для вигляду від 3-ї особи
    myAvatar = model.clone(true);
    myAvatar.visible = false;
    scene.add(myAvatar);

    for (const rp of remotePlayers.values()) if (!rp.obj) attachAgentModel(rp);
  }, undefined, (err) => console.error('agent load error', err));
}

function attachAgentModel(rp) {
  if (!agentTemplate) return;
  const model = agentTemplate.clone(true);
  const group = new THREE.Group();
  group.add(model);
  const hitSphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 6, 6),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hitSphere.position.y = 1.1;
  group.add(hitSphere);
  group.userData.playerId = rp.id;
  scene.add(group);
  rp.obj = group;
  rp.hitSphere = hitSphere;
}

function enterWorld() {
  menuEl.style.display = 'none';
  hudEl.classList.remove('hidden');
  if (!renderer) initScene();
  worldReady = true;
  renderer.domElement.requestPointerLock && renderer.domElement.requestPointerLock();
}

function respawnAt(zone) {
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    const ox = zone.sx + (Math.random() * 2 - 1) * zone.radius;
    const oy = zone.sy + (Math.random() * 2 - 1) * zone.radius;
    const wx = ox * SCALE;
    const wz = -oy * SCALE;
    
    downRay.set(new THREE.Vector3(wx, 1000, wz), new THREE.Vector3(0, -1, 0));
    downRay.far = 2000;
    const hits = mapMeshes.length ? downRay.intersectObjects(mapMeshes, false) : [];
    if (hits.length) {
      playerPos.set(wx, hits[0].point.y + EYE_HEIGHT, wz);
      found = true;
    }
  }
  if (!found) {
    playerPos.set(zone.sx * SCALE, 10, -zone.sy * SCALE);
  }
  yaw = Math.random() * Math.PI * 2;
  pitch = 0;
}

const moveDir = new THREE.Vector3();
function updateMovement(dt) {
  // Виправляємо напрямки руху (тепер W завжди вперед туди, куди дивиться камера)
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  
  moveDir.set(0, 0, 0);
  if (keys['KeyW']) moveDir.add(forward);
  if (keys['KeyS']) moveDir.sub(forward);
  if (keys['KeyD']) moveDir.add(right);
  if (keys['KeyA']) moveDir.sub(right);
  
  if (moveDir.lengthSq() > 0) {
    moveDir.normalize().multiplyScalar(MOVE_SPEED * dt);
  }

  playerPos.x += moveDir.x;
  playerPos.z += moveDir.z;

  // Плавне прилипання до підлоги без стрибків
  downRay.set(new THREE.Vector3(playerPos.x, playerPos.y + 3.0, playerPos.z), new THREE.Vector3(0, -1, 0));
  downRay.far = 10.0;
  const hits = mapMeshes.length ? downRay.intersectObjects(mapMeshes, false) : [];
  if (hits.length) {
    const targetY = hits[0].point.y + EYE_HEIGHT;
    playerPos.y += (targetY - playerPos.y) * Math.min(1, dt * 10);
  }

  // Налаштування камери залежно від режиму (1-ша чи 3-тя особа)
  if (thirdPerson) {
    // Зміщуємо камеру назад і вгору для 3-го обличчя
    const offset = new THREE.Vector3(0, 1.8, 3.0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    camera.position.copy(playerPos).add(offset);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    if (myAvatar) {
      myAvatar.position.copy(playerPos);
      myAvatar.position.y -= EYE_HEIGHT; // Ставимо по стопи
      myAvatar.rotation.y = yaw;
    }
  } else {
    camera.position.copy(playerPos);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }
}

function tryAttack() {
  const now = performance.now();
  if (now - lastAttackLocal < ZEUS_COOLDOWN_MS) return;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  raycaster.set(camera.position, dir);
  raycaster.far = ZEUS_CLIENT_RANGE;
  const spheres = [...remotePlayers.values()].filter(rp => rp.obj && rp.alive).map(rp => rp.hitSphere);
  const hits = raycaster.intersectObjects(spheres, false);
  if (zeusActions['firstperson_shoot1']) {
    zeusActions['firstperson_shoot1'].reset().play();
  }
  if (hits.length) {
    const sphere = hits[0].object;
    const id = sphere.parent.userData.playerId;
    ws && ws.send(JSON.stringify({ t: 'attack', targetId: id }));
    lastAttackLocal = now;
  } else {
    lastAttackLocal = now;
  }
}

function applyState(players) {
  const seen = new Set();
  for (const p of players) {
    seen.add(p.id);
    if (p.id === myId) {
      healthBar.style.width = Math.max(0, p.hp) + '%';
      healthText.textContent = Math.max(0, p.hp);
      continue;
    }
    let rp = remotePlayers.get(p.id);
    if (!rp) {
      rp = { id: p.id, obj: null, alive: p.alive, name: p.name, target: { x: 0, y: 0, z: 0, rotY: 0 } };
      remotePlayers.set(p.id, rp);
      if (agentTemplate) attachAgentModel(rp);
    }
    rp.alive = p.alive;
    const wx = p.x, wy = p.y, wz = p.z;
    rp.target.x = wx; rp.target.y = wy; rp.target.z = wz; rp.target.rotY = p.rotY;
    if (rp.obj) rp.obj.visible = p.alive;
  }
  for (const id of [...remotePlayers.keys()]) if (!seen.has(id)) removeRemote(id);
}

function removeRemote(id) {
  const rp = remotePlayers.get(id);
  if (rp && rp.obj) scene.remove(rp.obj);
  remotePlayers.delete(id);
}

setInterval(() => {
  if (!worldReady || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    t: 'input', x: playerPos.x, y: playerPos.y - EYE_HEIGHT, z: playerPos.z,
    rotY: yaw, pitch
  }));
}, 50);

function tick() {
  const dt = Math.min(0.05, clock.getDelta());
  if (worldReady) {
    updateMovement(dt);
    if (zeusMixer) zeusMixer.update(dt);
    for (const rp of remotePlayers.values()) {
      if (!rp.obj) continue;
      rp.obj.position.lerp(new THREE.Vector3(rp.target.x, rp.target.y, rp.target.z), Math.min(1, dt * 10));
      const curY = rp.obj.rotation.y;
      let diff = rp.target.rotY - curY;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      rp.obj.rotation.y = curY + diff * Math.min(1, dt * 10);
    }
  }
  if (renderer) renderer.render(scene, camera);
}
