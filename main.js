function respawnAt(zone) {
  let found = false;
  // Розширюємо діапазон перевірки висоти, щоб точно знайти поверхню деста
  for (let i = 0; i < 40 && !found; i++) {
    const ox = zone.sx + (Math.random() * 2 - 1) * zone.radius;
    const oy = zone.sy + (Math.random() * 2 - 1) * zone.radius;
    const wx = ox * SCALE;
    const wz = -oy * SCALE;
    
    // Кидаємо промінь з дуже великої висоти вниз
    downRay.set(new THREE.Vector3(wx, 1000, wz), new THREE.Vector3(0, -1, 0));
    downRay.far = 2000;
    const hits = mapMeshes.length ? downRay.intersectObjects(mapMeshes, false) : [];
    if (hits.length) {
      // Знаходимо найвищу точку підлоги під точкою спавну
      playerPos.set(wx, hits[0].point.y + EYE_HEIGHT, wz);
      found = true;
    }
  }
  // Запасний варіант, якщо промінь не спрацював з першого разу
  if (!found) {
    playerPos.set(zone.sx * SCALE, 10, -zone.sy * SCALE);
  }
  yaw = Math.random() * Math.PI * 2;
  pitch = 0;
}

const moveDir = new THREE.Vector3();
function updateMovement(dt) {
  const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw) * -1);
  const right = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  moveDir.set(0, 0, 0);
  if (keys['KeyW']) moveDir.add(forward);
  if (keys['KeyS']) moveDir.sub(forward);
  if (keys['KeyD']) moveDir.add(right);
  if (keys['KeyA']) moveDir.sub(right);
  
  if (moveDir.lengthSq() > 0) {
    moveDir.normalize().multiplyScalar(MOVE_SPEED * dt);
  }

    // Проста і плавна зміна позиції з урахуванням підлоги
  playerPos.x += moveDir.x;
  playerPos.z += moveDir.z;

  // Постійне вирівнювання висоти за мешами мапи під ногами (гравітація / прилипання до підлоги)
  downRay.set(new THREE.Vector3(playerPos.x, playerPos.y + 5.0, playerPos.z), new THREE.Vector3(0, -1, 0));
  downRay.far = 20.0;
  const hits = mapMeshes.length ? downRay.intersectObjects(mapMeshes, false) : [];
  if (hits.length) {
    const targetY = hits[0].point.y + EYE_HEIGHT;
    // Плавне інтерполювання висоти, щоб не було різких стрибків на сходах
    playerPos.y += (targetY - playerPos.y) * Math.min(1, dt * 12);
  }

  camera.position.copy(playerPos);
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
}
