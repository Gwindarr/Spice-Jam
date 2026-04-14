export function initMobileControls(options = {}) {
  const {
    controls,
    onMove,
    onLookDelta,
    onJump,
    onPrimaryStart,
    onPrimaryEnd,
    onInteractChange,
    onEquipWeapon,
    onToggleShield,
    onDeployThumper,
  } = options;

  if (!controls || document.getElementById("mobile-controls-root")) return;

  document.documentElement.style.touchAction = "none";
  document.body.style.touchAction = "none";
  document.body.classList.add("spice-mobile-ui");

  const style = document.createElement("style");
  style.id = "mobile-controls-style";
  style.textContent = `
    #mobile-controls-root {
      position: fixed;
      inset: 0;
      z-index: 40;
      display: none;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      pointer-events: none;
      font-family: Arial, sans-serif;
    }
    #mobile-controls-root.active {
      display: block;
    }
    .mc-look-zone {
      position: absolute;
      inset: 0 0 0 34%;
      pointer-events: auto;
      touch-action: none;
    }
    .mc-stick-wrap {
      position: absolute;
      left: 18px;
      bottom: 22px;
      width: 170px;
      height: 170px;
      pointer-events: auto;
      touch-action: none;
    }
    .mc-stick-base,
    .mc-stick-thumb {
      position: absolute;
      border-radius: 50%;
      transform: translate(-50%, -50%);
    }
    .mc-stick-base {
      left: 50%;
      top: 50%;
      width: 128px;
      height: 128px;
      border: 2px solid rgba(244, 211, 140, 0.35);
      background: radial-gradient(circle, rgba(48, 31, 14, 0.28), rgba(10, 8, 7, 0.06));
      box-shadow: 0 0 0 1px rgba(255, 214, 149, 0.08) inset;
    }
    .mc-stick-thumb {
      left: 50%;
      top: 50%;
      width: 58px;
      height: 58px;
      border: 2px solid rgba(255, 231, 176, 0.7);
      background: radial-gradient(circle, rgba(255, 227, 162, 0.4), rgba(118, 84, 35, 0.34));
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
    }
    .mc-buttons {
      position: absolute;
      right: 14px;
      bottom: 16px;
      width: 252px;
      height: 258px;
      pointer-events: none;
    }
    .mc-button,
    .mc-weapon-btn {
      position: absolute;
      pointer-events: auto;
      touch-action: none;
      border: 1px solid rgba(250, 220, 145, 0.58);
      background: rgba(28, 18, 8, 0.52);
      color: #f7e3b2;
      box-shadow: 0 10px 18px rgba(0, 0, 0, 0.18);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    .mc-button {
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .mc-button.active,
    .mc-weapon-btn.active {
      background: rgba(134, 89, 28, 0.74);
      transform: scale(0.97);
    }
    .mc-attack {
      right: 0;
      bottom: 0;
      width: 104px;
      height: 104px;
    }
    .mc-jump {
      right: 118px;
      bottom: 12px;
      width: 76px;
      height: 76px;
      font-size: 12px;
    }
    .mc-interact {
      right: 22px;
      bottom: 128px;
      width: 74px;
      height: 74px;
      font-size: 15px;
    }
    .mc-shield {
      right: 108px;
      bottom: 132px;
      width: 58px;
      height: 58px;
      font-size: 10px;
    }
    .mc-thumper {
      right: 170px;
      bottom: 132px;
      width: 52px;
      height: 52px;
      font-size: 9px;
    }
    .mc-weapon-bar {
      position: absolute;
      right: 14px;
      bottom: 210px;
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: auto;
    }
    .mc-weapon-label {
      display: none;
    }
    .mc-weapon-btn {
      position: relative;
      min-width: 42px;
      padding: 8px 0;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #f6e0aa;
      text-align: center;
    }
    .mc-tag {
      position: absolute;
      left: 50%;
      top: -18px;
      transform: translateX(-50%);
      font-size: 10px;
      letter-spacing: 0.12em;
      color: rgba(247, 227, 178, 0.72);
      text-transform: uppercase;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "mobile-controls-root";

  const lookZone = document.createElement("div");
  lookZone.className = "mc-look-zone";

  const stickWrap = document.createElement("div");
  stickWrap.className = "mc-stick-wrap";
  const stickBase = document.createElement("div");
  stickBase.className = "mc-stick-base";
  const stickThumb = document.createElement("div");
  stickThumb.className = "mc-stick-thumb";
  const stickTag = document.createElement("div");
  stickTag.className = "mc-tag";
  stickTag.textContent = "Move";
  stickWrap.append(stickTag, stickBase, stickThumb);

  const buttons = document.createElement("div");
  buttons.className = "mc-buttons";

  const attackBtn = document.createElement("button");
  attackBtn.type = "button";
  attackBtn.className = "mc-button mc-attack";
  attackBtn.textContent = "Attack";

  const jumpBtn = document.createElement("button");
  jumpBtn.type = "button";
  jumpBtn.className = "mc-button mc-jump";
  jumpBtn.textContent = "Jump";

  const interactBtn = document.createElement("button");
  interactBtn.type = "button";
  interactBtn.className = "mc-button mc-interact";
  interactBtn.textContent = "E";

  const shieldBtn = document.createElement("button");
  shieldBtn.type = "button";
  shieldBtn.className = "mc-button mc-shield";
  shieldBtn.textContent = "Shield";

  const thumperBtn = document.createElement("button");
  thumperBtn.type = "button";
  thumperBtn.className = "mc-button mc-thumper";
  thumperBtn.textContent = "Thump";

  buttons.append(attackBtn, jumpBtn, interactBtn, shieldBtn, thumperBtn);

  const weaponLabel = document.createElement("div");
  weaponLabel.className = "mc-weapon-label";
  weaponLabel.textContent = "Weapon";

  const weaponBar = document.createElement("div");
  weaponBar.className = "mc-weapon-bar";

  const weaponButtons = [
    { weapon: "knife", label: "1" },
    { weapon: "maula", label: "2" },
    { weapon: "lasgun", label: "3" },
  ].map((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mc-weapon-btn";
    btn.textContent = item.label;
    btn.dataset.weapon = item.weapon;
    weaponBar.appendChild(btn);
    return btn;
  });

  root.append(lookZone, stickWrap, buttons, weaponLabel, weaponBar);
  document.body.appendChild(root);

  const joystick = {
    pointerId: null,
    radius: 52,
    centerX: 85,
    centerY: 85,
  };
  const look = {
    pointerId: null,
    lastX: 0,
    lastY: 0,
  };
  const actionPointers = {
    attack: null,
    interact: null,
  };

  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const setWeaponActive = (weapon) => {
    for (const btn of weaponButtons) {
      btn.classList.toggle("active", btn.dataset.weapon === weapon);
    }
  };

  const releaseJoystick = () => {
    joystick.pointerId = null;
    stickThumb.style.left = "50%";
    stickThumb.style.top = "50%";
    onMove?.(0, 0);
  };

  const updateJoystick = (clientX, clientY) => {
    const rect = stickWrap.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const dx = localX - joystick.centerX;
    const dy = localY - joystick.centerY;
    const dist = Math.hypot(dx, dy);
    const clamped = dist > joystick.radius ? joystick.radius / dist : 1;
    const px = dx * clamped;
    const py = dy * clamped;
    stickThumb.style.left = `${50 + (px / rect.width) * 100}%`;
    stickThumb.style.top = `${50 + (py / rect.height) * 100}%`;
    const moveX = px / joystick.radius;
    const moveY = -(py / joystick.radius);
    onMove?.(moveX, moveY);
  };

  const releaseActions = () => {
    if (actionPointers.attack !== null) {
      actionPointers.attack = null;
      attackBtn.classList.remove("active");
      onPrimaryEnd?.();
    }
    if (actionPointers.interact !== null) {
      actionPointers.interact = null;
      interactBtn.classList.remove("active");
      onInteractChange?.(false);
    }
  };

  const releaseAll = () => {
    releaseJoystick();
    releaseActions();
    look.pointerId = null;
  };

  stickWrap.addEventListener("pointerdown", (event) => {
    if (!controls.isLocked || joystick.pointerId !== null) return;
    stop(event);
    joystick.pointerId = event.pointerId;
    stickWrap.setPointerCapture?.(event.pointerId);
    updateJoystick(event.clientX, event.clientY);
  });

  lookZone.addEventListener("pointerdown", (event) => {
    if (!controls.isLocked || look.pointerId !== null) return;
    stop(event);
    look.pointerId = event.pointerId;
    look.lastX = event.clientX;
    look.lastY = event.clientY;
    lookZone.setPointerCapture?.(event.pointerId);
  });

  window.addEventListener("pointermove", (event) => {
    if (event.pointerId === joystick.pointerId) {
      stop(event);
      updateJoystick(event.clientX, event.clientY);
      return;
    }
    if (event.pointerId === look.pointerId) {
      stop(event);
      const dx = event.clientX - look.lastX;
      const dy = event.clientY - look.lastY;
      look.lastX = event.clientX;
      look.lastY = event.clientY;
      onLookDelta?.(dx, dy);
    }
  }, { passive: false });

  window.addEventListener("pointerup", (event) => {
    if (event.pointerId === joystick.pointerId) {
      releaseJoystick();
    }
    if (event.pointerId === look.pointerId) {
      look.pointerId = null;
    }
    if (event.pointerId === actionPointers.attack) {
      actionPointers.attack = null;
      attackBtn.classList.remove("active");
      onPrimaryEnd?.();
    }
    if (event.pointerId === actionPointers.interact) {
      actionPointers.interact = null;
      interactBtn.classList.remove("active");
      onInteractChange?.(false);
    }
  });

  window.addEventListener("pointercancel", (event) => {
    if (event.pointerId === joystick.pointerId) releaseJoystick();
    if (event.pointerId === look.pointerId) look.pointerId = null;
    if (event.pointerId === actionPointers.attack || event.pointerId === actionPointers.interact) {
      releaseActions();
    }
  });

  attackBtn.addEventListener("pointerdown", (event) => {
    if (!controls.isLocked) return;
    stop(event);
    actionPointers.attack = event.pointerId;
    attackBtn.classList.add("active");
    onPrimaryStart?.();
  });

  interactBtn.addEventListener("pointerdown", (event) => {
    if (!controls.isLocked) return;
    stop(event);
    actionPointers.interact = event.pointerId;
    interactBtn.classList.add("active");
    onInteractChange?.(true);
  });

  jumpBtn.addEventListener("pointerdown", (event) => {
    if (!controls.isLocked) return;
    stop(event);
    jumpBtn.classList.add("active");
    onJump?.();
  });
  jumpBtn.addEventListener("pointerup", () => jumpBtn.classList.remove("active"));
  jumpBtn.addEventListener("pointercancel", () => jumpBtn.classList.remove("active"));

  shieldBtn.addEventListener("pointerdown", (event) => {
    if (!controls.isLocked) return;
    stop(event);
    shieldBtn.classList.add("active");
    onToggleShield?.();
  });
  shieldBtn.addEventListener("pointerup", () => shieldBtn.classList.remove("active"));
  shieldBtn.addEventListener("pointercancel", () => shieldBtn.classList.remove("active"));

  thumperBtn.addEventListener("pointerdown", (event) => {
    if (!controls.isLocked) return;
    stop(event);
    thumperBtn.classList.add("active");
    onDeployThumper?.();
  });
  thumperBtn.addEventListener("pointerup", () => thumperBtn.classList.remove("active"));
  thumperBtn.addEventListener("pointercancel", () => thumperBtn.classList.remove("active"));

  for (const btn of weaponButtons) {
    btn.addEventListener("pointerdown", (event) => {
      if (!controls.isLocked) return;
      stop(event);
      const weapon = btn.dataset.weapon;
      setWeaponActive(weapon);
      onEquipWeapon?.(weapon);
    });
  }
  setWeaponActive("knife");

  controls.addEventListener("lock", () => {
    root.classList.add("active");
  });

  controls.addEventListener("unlock", () => {
    root.classList.remove("active");
    releaseAll();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      releaseAll();
    }
  });
}