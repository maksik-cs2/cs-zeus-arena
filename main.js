// ============================================================================
// CS ZEUS ARENA - ENTERPRISE CLIENT CONTROLLER
// Модуль ігрового клієнта на Three.js (r128) та WebSocket
// ============================================================================

// ---------- 1. КОНСТАНТИ ТА ПАРАМЕТРИ ФІЗИКИ ----------
const SCALE = 0.0254;          
const EYE_HEIGHT = 1.72;       
const MOVE_SPEED = 4.4;        
const PLAYER_RADIUS = 0.38;    
const ZEUS_CLIENT_RANGE = 3.2; 
const ZEUS_COOLDOWN_MS = 1100; 

// ---------- 2. DOM-ЕЛЕМЕНТИ ТА HUD ----------
const el = (id) => document.getElementById(id);
const menuEl = el('menu');
const hudEl = el('hud');
const statusEl = el('menuStatus');
const waitOverlay = el('waitOverlay');
const waitCount = el('waitCount');
const healthBar = el('healthBar');
const healthText = el('healthText');
const roomBadge = el('roomBadge');
const scoreBadge = el('scoreBadge');
const killfeedEl = el('killfeed');
const centerMsg = el('centerMsg');
const scoreboardEl = el('scoreboard');

// ---------- 3. МЕНЮ ВИБОРУ РЕЖИМІВ ТА КОМАНД ----------
let selectedGameMode = 'ffa';
let selectedPlayerTeam = 'random'; 

document.querySelectorAll('.modeBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.modeBtn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedGameMode = btn.dataset.mode;
    
    if (['2v2', '3v3', '4v4', '1v1'].includes(selectedGameMode)) {
      renderTeamSelectionPanel();
    } else {
      initializeGameConnection({ mode: selectedGameMode, team: 'random' });
    }
  });
});

function renderTeamSelectionPanel() {
  statusEl.innerHTML = `
    <div style="margin-top:12px; padding:16px; background:rgba(20,20,25,0.9); border-radius:8px; border:1px solid #444;">
      <p style="margin-bottom:10px; color:#ffb020; font-weight:bold; font-size:14px;">Оберіть бійцівську сторону:</p>
      <button id="chooseT" style="background:#a65b28; color:#fff; padding:8px 16px; margin-right:8px; border:none; border-radius:6px; cursor:pointer; font-weight:bold;">Терористи (T)</button>
      <button id="chooseCT" style="background:#2b5ca6; color:#fff; padding:8px 16px; border:none; border-radius:6px; cursor:pointer; font-weight:bold;">Спецназ (CT)</button>
    </div>
  `;
  
  setTimeout(() => {
    const btnT = el('chooseT');
    const btnCT = el('chooseCT');
    if (btnT) btnT.addEventListener('click', () => { selectedPlayerTeam = 'T'; initializeGameConnection({ mode: selectedGameMode, team: 'T' }); });
    if (btnCT) btnCT.addEventListener('click', () => { selectedPlayerTeam = 'CT'; initializeGameConnection({ mode: selectedGameMode, team: 'CT' }); });
  }, 50);
}

el('createPrivateBtn').addEventListener('click', () => initializeGameConnection({ mode: selectedGameMode, team: selectedPlayerTeam, createPrivate: true }));
el('joinCodeBtn').addEventListener('click', () => {
  const roomCodeValue = el('codeInput').value.trim().toUpperCase();
  if (!roomCodeValue) { statusEl.textContent = 'Введіть код кімнати'; return; }
  initializeGameConnection({ roomCode: roomCodeValue, team: selectedPlayerTeam });
});

// ---------- 4. МЕРЕЖЕВИЙ КЛІЄНТ (WEBSOCKET) ----------
let socketConnection = null;
let localPlayerId = null;
let localPlayerTeam = null;
let activeRoomMode = null;
let activeRoomCode = null;
const remotePlayersRegistry = new Map();

function resolveWebSocketAddress() {
  const customAddr = el('serverInput') ? el('serverInput').value.trim() : '';
  const networkProtocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
  if (!customAddr) return networkProtocol + location.host;
  if (customAddr.startsWith('ws://') || customAddr.startsWith('wss://')) return customAddr;
  return networkProtocol + customAddr;
}

function initializeGameConnection(options) {
  statusEl.textContent = "Підключення до сервера…";
  try {
    socketConnection = new WebSocket(resolveWebSocketAddress());
  } catch (err) {
    statusEl.textContent = "Помилка підключення";
    return;
  }

  socketConnection.onopen = () => {
    socketConnection.send(JSON.stringify({
      t: 'join',
      mode: options.mode || 'ffa',
      team: options.team || 'random',
      roomCode: options.roomCode || '',
      createPrivate: !!options.createPrivate,
      name: el('nameInput').value.trim() || 'Гравець'
    }));
  };

  socketConnection.onclose = () => {
    statusEl.textContent = "З'єднання розірвано";
  };

  socketConnection.onerror = () => {
    statusEl.textContent = "Помилка мережі";
  };

  socketConnection.onmessage = (event) => {
    try {
      const parsedPacket = JSON.parse(event.data);
      processServerPacket(parsedPacket);
    } catch (parseError) {
      console.error('Помилка парсингу:', parseError);
    }
  };
}

function processServerPacket(packet) {
  switch (packet.t) {
    case 'welcome':
      localPlayerId = packet.id;
      localPlayerTeam = packet.team;
      activeRoomMode = packet.mode;
      activeRoomCode = packet.roomCode;
      
      let teamStr = localPlayerTeam === 'T' ? ' [Терористи]' : (localPlayerTeam === 'CT' ? ' [Спецназ]' : '');
      roomBadge.textContent = `Кімната: ${activeRoomCode} | Режим: ${activeRoomMode.toUpperCase()}${teamStr}`;
      
      if (packet.waiting) {
        waitOverlay.classList.remove('hidden');
        waitCount.textContent = 'Очікування гравців…';
      }
      break;

    case 'roomInfo':
      if (waitOverlay && !waitOverlay.classList.contains('hidden')) {
        const targetCapacity = packet.mode === 'ffa' ? 2 : fetchModeLimit(packet.mode);
        waitCount.textContent = `(${packet.players.length}/${targetCapacity})`;
      }
      break;

    case 'start':
      waitOverlay.classList.add('hidden');
      bootGameWorld();
      respawnAt(packet.zone);
      break;

    case 'respawn':
      respawnAt(packet.zone);
      break;

    case 'death':
      triggerCenterNotification(`Вас вбив ${packet.by}`, 1600);
      break;

    case 'state':
      syncRemotePlayersState(packet.players);
      break;

    case 'killfeed':
      pushKillfeedMessage(packet.killer, packet.victim);
      break;

    case 'score':
      scoreBadge.textContent = `Рахунок — T: ${packet.scores.A || 0} | CT: ${packet.scores.B || 0}`;
      break;

    case 'end':
      renderMatchEndScoreboard(packet);
      break;

    case 'leave':
      disposeRemotePlayer(packet.id);
      break;

    case 'error':
      statusEl.textContent = packet.msg;
      break;
  }
}

function fetchModeLimit(modeName) {
  const limits = { 'ffa': 8, '1v1': 2, '2v2': 4, '3v3': 6, '4v4': 8 };
  return limits[modeName] || 2;
}

function pushKillfeedMessage(killerName, victimName) {
  const line = document.createElement('div');
  line.style.margin = '4px 0';
  line.style.padding = '3px 8px';
  line.style.background = 'rgba(0,0,0,0.65)';
  line.style.borderRadius = '4px';
  line.textContent = `${killerName} ⚡ ${victimName}`;
  killfeedEl.appendChild(line);
  setTimeout(() => line.remove(), 4000);
}

function triggerCenterNotification(messageText, duration) {
  centerMsg.textContent = messageText;
  clearTimeout(triggerCenterNotification._timer);
  triggerCenterNotification._timer = setTimeout(() => { centerMsg.textContent = ''; }, duration);
}

function renderMatchEndScoreboard(data) {
  if (document.exitPointerLock) document.exitPointerLock();
  scoreboardEl.classList.remove('hidden');
  scoreboardEl.innerHTML = `
    <div style="text-align:center; background:rgba(15,15,22,0.95); padding:40px; border-radius:12px; border:2px solid #ffb020;">
      <h2 style="color:#ffb020; margin-bottom:12px;">МАТЧ ЗАВЕРШЕНО</h2>
      <p style="font-size:20px; color:#fff; margin-bottom:15px;">Перемогла сторона: <b>${data.winner}</b></p>
      <p style="font-size:16px; color:#aaa; margin-bottom:25px;">Рахунок: ${data.scores.A || 0} / ${data.scores.B || 0}</p>
      <button onclick="location.reload()" style="padding:12px 28px; border-radius:8px; border:none; background:#ffb020; color:#111; font-weight:bold; cursor:pointer;">До меню</button>
    </div>`;
}

// ---------- 5. THREE.JS ГРАФІЧНИЙ ДВИГУН ----------
let renderEngine, mainScene, activeCamera, mapGroupContainer = null;
let collisionMeshesList = [];
let deltaClock = new THREE.Clock();
let zeusWeaponMesh = null, zeusAnimationMixer = null, zeusAnimationActions = {};
let playerModelTemplate = null;
let primaryAvatarMesh = null;
let isThirdPersonActive = false;

const hitRaycaster = new THREE.Raycaster();
const groundRaycaster = new THREE.Raycaster();
const wallRaycaster = new THREE.Raycaster();

let yawAngle = 0, pitchAngle = 0;
let playerWorldPos = new THREE.Vector3(0, 5, 0);
let lastAttackTick = 0;
let keyboardState = {};
let isEngineActive = false, isMouseLocked = false;

function bootGameWorld() {
  menuEl.style.display = 'none';
  hudEl.classList.remove('hidden');
  if (!renderEngine) initThreeJsEngine();
  isEngineActive = true;
  if (renderEngine.domElement.requestPointerLock) {
    renderEngine.domElement.requestPointerLock();
  }
}

function initThreeJsEngine() {
  renderEngine = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderEngine.setSize(window.innerWidth, window.innerHeight);
  renderEngine.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderEngine.shadowMap.enabled = false;
  document.body.appendChild(renderEngine.domElement);

  mainScene = new THREE.Scene();
  mainScene.background = new THREE.Color(0x9fc2e0);
  mainScene.fog = new THREE.Fog(0x9fc2e0, 45, 180);

  activeCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 500);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
  mainScene.add(hemiLight);
  
  const sunLight = new THREE.DirectionalLight(0xfff3d6, 1.5);
  sunLight.position.set(70, 100, 50);
  mainScene.add(sunLight);

  window.addEventListener('resize', () => {
    activeCamera.aspect = window.innerWidth / window.innerHeight;
    activeCamera.updateProjectionMatrix();
    renderEngine.setSize(window.innerWidth, window.innerHeight);
  });

  loadMapGeometry();
  loadZeusModelAsset();
  loadAgentModelAsset();

  renderEngine.domElement.addEventListener('click', () => {
    if (isEngineActive && renderEngine.domElement.requestPointerLock) {
      renderEngine.domElement.requestPointerLock();
    }
  });

  document.addEventListener('pointerlockchange', () => {
    isMouseLocked = document.pointerLockElement === renderEngine.domElement;
  });

  document.addEventListener('mousemove', (e) => {
    if (!isMouseLocked) return;
    yawAngle -= e.movementX * 0.0022;
    pitchAngle -= e.movementY * 0.0022;
    pitchAngle = Math.max(-1.35, Math.min(1.35, pitchAngle));
  });

  document.addEventListener('mousedown', (e) => {
    if (isMouseLocked && e.button === 0) executeZeusAttack();
  });

  document.addEventListener('keydown', (e) => {
    keyboardState[e.code] = true;
    if (e.code === 'F3') {
      e.preventDefault();
      isThirdPersonActive = !isThirdPersonActive;
      if (primaryAvatarMesh) primaryAvatarMesh.visible = isThirdPersonActive;
      if (zeusWeaponMesh) zeusWeaponMesh.visible = !isThirdPersonActive;
    }
  });

  document.addEventListener('keyup', (e) => {
    keyboardState[e.code] = false;
  });

  renderEngine.setAnimationLoop(mainGameTick);
}

function loadMapGeometry() {
  const mtlLoader = new THREE.MTLLoader();
  mtlLoader.setPath('assets/map/');
  mtlLoader.setResourcePath('assets/map/textures/');
  mtlLoader.load('de_dust2.mtl', (materials) => {
    materials.preload();
    for (const m in materials.materials) {
      materials.materials[m].side = THREE.DoubleSide;
    }
    const objLoader = new THREE.OBJLoader();
    objLoader.setMaterials(materials);
    objLoader.setPath('assets/map/');
    objLoader.load('de_dust2.obj', (obj) => {
      obj.rotation.x = -Math.PI / 2;
      obj.scale.setScalar(SCALE);
      obj.traverse((child) => {
        if (child.isMesh) collisionMeshesList.push(child);
      });
      mapGroupContainer = obj;
      mainScene.add(obj);
    }, undefined, (err) => console.error('Помилка об’єкту мапи:', err));
  }, undefined, (err) => console.error('Помилка матеріалів мапи:', err));
}

function loadZeusModelAsset() {
  new THREE.GLTFLoader().load('assets/models/zeus.glb', (gltf) => {
    zeusWeaponMesh = gltf.scene;
    const box = new THREE.Box3().setFromObject(zeusWeaponMesh);
    const size = new THREE.Vector3(); box.getSize(size);
    const scaleFactor = 0.26 / Math.max(size.x, size.y, size.z);
    
    zeusWeaponMesh.scale.setScalar(scaleFactor);
    zeusWeaponMesh.position.set(0.22, -0.22, -0.4);
    zeusWeaponMesh.rotation.set(0, Math.PI, 0);
    activeCamera.add(zeusWeaponMesh);

    if (gltf.animations && gltf.animations.length) {
      zeusAnimationMixer = new THREE.AnimationMixer(zeusWeaponMesh);
      for (const clip of gltf.animations) {
        zeusAnimationActions[clip.name] = zeusAnimationMixer.clipAction(clip);
      }
      if (zeusAnimationActions['firstperson_idle']) {
        zeusAnimationActions['firstperson_idle'].play();
      }
    }
  }, undefined, (err) => console.error('Помилка зброї Зевс:', err));
}

function loadAgentModelAsset() {
  new THREE.GLTFLoader().load('assets/models/agent.gltf', (gltf) => {
    const raw = gltf.scene;
    const box = new THREE.Box3().setFromObject(raw);
    const size = new THREE.Vector3(); box.getSize(size);
    const scaleFactor = 1.8 / Math.max(size.y, 0.01);
    raw.scale.setScalar(scaleFactor);
    
    const boxRecalc = new THREE.Box3().setFromObject(raw);
    raw.position.y -= boxRecalc.min.y;
    playerModelTemplate = raw;

    primaryAvatarMesh = playerModelTemplate.clone(true);
    primaryAvatarMesh.visible = false;
    mainScene.add(primaryAvatarMesh);

    for (const rp of remotePlayersRegistry.values()) {
      if (!rp.obj) createRemotePlayerMesh(rp);
    }
  }, undefined, (err) => console.error('Помилка моделі агента:', err));
}

function createRemotePlayerMesh(record) {
  if (!playerModelTemplate) return;
  const clone = playerModelTemplate.clone(true);
  const wrapper = new THREE.Group();
  wrapper.add(clone);

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 6, 6),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  sphere.position.y = 1.1;
  wrapper.add(sphere);
  
  wrapper.userData.playerId = record.id;
  mainScene.add(wrapper);
  
  record.obj = wrapper;
  record.hitSphere = sphere;
}

// ---------- 6. ФІЗИЧНИЙ МОДУЛЬ РУХУ ----------
function respawnAt(zone) {
  let placed = false;
  for (let i = 0; i < 45 && !placed; i++) {
    const rx = zone.sx + (Math.random() * 2 - 1) * zone.radius;
    const rz = zone.sy + (Math.random() * 2 - 1) * zone.radius;
    const wx = rx * SCALE;
    const wz = -rz * SCALE;
    
    groundRaycaster.set(new THREE.Vector3(wx, 1000, wz), new THREE.Vector3(0, -1, 0));
    groundRaycaster.far = 2500;
    const hits = collisionMeshesList.length ? groundRaycaster.intersectObjects(collisionMeshesList, false) : [];
    
    if (hits.length > 0) {
      playerWorldPos.set(wx, hits[0].point.y + EYE_HEIGHT, wz);
      placed = true;
    }
  }
  if (!placed) {
    playerWorldPos.set(zone.sx * SCALE, 15, -zone.sy * SCALE);
  }
  yawAngle = Math.random() * Math.PI * 2;
  pitchAngle = 0;
}

const displacement = new THREE.Vector3();
function updatePlayerPhysics(dt) {
  const fwd = new THREE.Vector3(-Math.sin(yawAngle), 0, -Math.cos(yawAngle));
  const rt = new THREE.Vector3(Math.cos(yawAngle), 0, -Math.sin(yawAngle));
  
  displacement.set(0, 0, 0);
  if (keyboardState['KeyW']) displacement.add(fwd);
  if (keyboardState['KeyS']) displacement.sub(fwd);
  if (keyboardState['KeyD']) displacement.add(rt);
  if (keyboardState['KeyA']) displacement.sub(rt);
  
  if (displacement.lengthSq() > 0) {
    displacement.normalize().multiplyScalar(MOVE_SPEED * dt);
  }

  if (collisionMeshesList.length && displacement.lengthSq() > 0) {
    const originCheck = playerWorldPos.clone().add(new THREE.Vector3(0, -0.4, 0));
    wallRaycaster.set(originCheck, displacement.clone().normalize());
    wallRaycaster.far = PLAYER_RADIUS + displacement.length();
    const walls = wallRaycaster.intersectObjects(collisionMeshesList, false);
    
    if (walls.length === 0) {
      playerWorldPos.x += displacement.x;
      playerWorldPos.z += displacement.z;
    }
  } else {
    playerWorldPos.x += displacement.x;
    playerWorldPos.z += displacement.z;
  }

  groundRaycaster.set(new THREE.Vector3(playerWorldPos.x, playerWorldPos.y + 2.5, playerWorldPos.z), new THREE.Vector3(0, -1, 0));
  groundRaycaster.far = 8.0;
  const floors = collisionMeshesList.length ? groundRaycaster.intersectObjects(collisionMeshesList, false) : [];
  if (floors.length > 0) {
    const targetFloorY = floors[0].point.y + EYE_HEIGHT;
    playerWorldPos.y += (targetFloorY - playerWorldPos.y) * Math.min(1, dt * 10);
  }

  if (isThirdPersonActive) {
    const camOffset = new THREE.Vector3(0, 1.8, 3.2).applyAxisAngle(new THREE.Vector3(0, 1, 0), yawAngle);
    activeCamera.position.copy(playerWorldPos).add(camOffset);
    activeCamera.rotation.set(pitchAngle, yawAngle, 0, 'YXZ');
    if (primaryAvatarMesh) {
      primaryAvatarMesh.position.copy(playerWorldPos);
      primaryAvatarMesh.position.y -= EYE_HEIGHT;
      primaryAvatarMesh.rotation.y = yawAngle;
    }
  } else {
    activeCamera.position.copy(playerWorldPos);
    activeCamera.rotation.set(pitchAngle, yawAngle, 0, 'YXZ');
  }
}

// ---------- 7. БОЙОВИЙ МОДУЛЬ ----------
function executeZeusAttack() {
  const currentMillis = performance.now();
  if (currentMillis - lastAttackTick < ZEUS_COOLDOWN_MS) return;

  const gazeDir = new THREE.Vector3();
  activeCamera.getWorldDirection(gazeDir);
  
  hitRaycaster.set(activeCamera.position, gazeDir);
  hitRaycaster.far = ZEUS_CLIENT_RANGE;
  
  const targetSpheres = [...remotePlayersRegistry.values()]
    .filter((rp) => rp.obj && rp.alive)
    .map((rp) => rp.hitSphere);
    
  const hits = hitRaycaster.intersectObjects(targetSpheres, false);

  if (zeusAnimationActions['firstperson_shoot1']) {
    zeusAnimationActions['firstperson_shoot1'].reset().play();
  }

  if (hits.length > 0) {
    const hitObj = hits[0].object;
    const enemyId = hitObj.parent.userData.playerId;
    if (socketConnection && socketConnection.readyState === WebSocket.OPEN) {
      socketConnection.send(JSON.stringify({ t: 'attack', targetId: enemyId }));
    }
  }
  lastAttackTick = currentMillis;
}

// ---------- 8. СИНХРОНІЗАЦІЯ ----------
function syncRemotePlayersState(list) {
  const activeIds = new Set();
  for (const p of list) {
    activeIds.add(p.id);
    if (p.id === localPlayerId) {
      const currentHp = Math.max(0, p.hp);
      healthBar.style.width = currentHp + '%';
      healthText.textContent = currentHp;
      continue;
    }

    let record = remotePlayersRegistry.get(p.id);
    if (!record) {
      record = {
        id: p.id,
        obj: null,
        hitSphere: null,
        alive: p.alive,
        name: p.name,
        target: { x: p.x, y: p.y, z: p.z, rotY: p.rotY }
      };
      remotePlayersRegistry.set(p.id, record);
      if (playerModelTemplate) createRemotePlayerMesh(record);
    }

    record.alive = p.alive;
    record.target.x = p.x;
    record.target.y = p.y;
    record.target.z = p.z;
    record.target.rotY = p.rotY;

    if (record.obj) {
      record.obj.visible = p.alive;
    }
  }

  for (const existingId of [...remotePlayersRegistry.keys()]) {
    if (!activeIds.has(existingId)) disposeRemotePlayer(existingId);
  }
}

function disposeRemotePlayer(id) {
  const record = remotePlayersRegistry.get(id);
  if (record && record.obj) {
    mainScene.remove(record.obj);
  }
  remotePlayersRegistry.delete(id);
}

setInterval(() => {
  if (!isEngineActive || !socketConnection || socketConnection.readyState !== WebSocket.OPEN) return;
  socketConnection.send(JSON.stringify({
    t: 'input',
    x: playerWorldPos.x,
    y: playerWorldPos.y - EYE_HEIGHT,
    z: playerWorldPos.z,
    rotY: yawAngle,
    pitch: pitchAngle
  }));
}, 50);

// ---------- 9. ЦИКЛ РЕНДЕРИНГУ ----------
function mainGameTick() {
  const dt = Math.min(0.05, deltaClock.getDelta());

  if (isEngineActive) {
    updatePlayerPhysics(dt);

    if (zeusAnimationMixer) {
      zeusAnimationMixer.update(dt);
    }

    for (const rp of remotePlayersRegistry.values()) {
      if (!rp.obj) continue;
      const targetPos = new THREE.Vector3(rp.target.x, rp.target.y, rp.target.z);
      rp.obj.position.lerp(targetPos, Math.min(1, dt * 12));
      
      const currentRotY = rp.obj.rotation.y;
      let diff = rp.target.rotY - currentRotY;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      rp.obj.rotation.y = currentRotY + diff * Math.min(1, dt * 12);
    }
  }

  if (renderEngine) {
    renderEngine.render(mainScene, activeCamera);
  }
}
