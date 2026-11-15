import * as Phaser from "phaser";
import {
  AnimSet,
  Entity,
  loadAnimationSheets,
  registerAnimations,
} from "./Entity";

/** Все состояния анимации игрока. */
export enum PlayerAnimState {
  Idle = "idle",
  Run = "run",
  Roll = "roll",
  Attack1 = "attack1",
  Attack2 = "attack2",
  Attack3 = "attack3",
  Hurt = "hurt",
  Death = "death",
}

/**
 * Анимации игрока. Новые спрайты находятся в public/assets/sprites/player.
 * Каждый спрайт содержит один кадр 256×256. Базовый масштаб 0.3
 * дополнительно умножается на общий масштаб сущности (2).
 * Спрайты смотрят вправо — при движении влево они отражаются автоматически.
 */
export const PLAYER_ANIMS: AnimSet<PlayerAnimState> = {
  [PlayerAnimState.Idle]: {
    key: "player-idle",
    sheet: { file: "sprites/player/calm.png", frameWidth: 256, frameHeight: 256, scale: 0.3 },
    frameRate: 1,
    repeat: 0,
    color: 0xebe10f,
  },
  [PlayerAnimState.Run]: {
    key: "player-run",
    sheet: { file: "sprites/player/run.png", frameWidth: 256, frameHeight: 256, scale: 0.3 },
    frameRate: 1,
    repeat: 0,
    color: 0xf5ec4a,
  },
  [PlayerAnimState.Roll]: {
    key: "player-roll",
    frameRate: 18,
    repeat: 0,
    color: 0xb8a22e,
  },
  [PlayerAnimState.Attack1]: {
    key: "player-attack1",
    sheet: { file: "sprites/player/attack1.png", frameWidth: 256, frameHeight: 256, scale: 0.3 },
    frameRate: 1,
    repeat: 0,
    color: 0xff9a1f,
  },
  [PlayerAnimState.Attack2]: {
    key: "player-attack2",
    sheet: { file: "sprites/player/attack2.png", frameWidth: 256, frameHeight: 256, scale: 0.3 },
    frameRate: 1,
    repeat: 0,
    color: 0xff6a1f,
  },
  [PlayerAnimState.Attack3]: {
    key: "player-attack3",
    sheet: { file: "sprites/player/attack3.png", frameWidth: 256, frameHeight: 256, scale: 0.3 },
    frameRate: 1,
    repeat: 0,
    color: 0xff3a1f,
  },
  [PlayerAnimState.Hurt]: {
    key: "player-hurt",
    sheet: { file: "sprites/player/damage.png", frameWidth: 256, frameHeight: 256, scale: 0.3 },
    frameRate: 1,
    repeat: 0,
    color: 0xffffff,
  },
  [PlayerAnimState.Death]: {
    key: "player-death",
    sheet: { file: "sprites/player/death.png", frameWidth: 256, frameHeight: 256, scale: 0.3 },
    frameRate: 1,
    repeat: 0,
    color: 0x6b5f10,
  },
};

/** Ставит в очередь загрузки спрайт-листы игрока (вызывается в Preloader.preload). */
export function loadPlayerSheets(scene: Phaser.Scene): void {
  loadAnimationSheets(scene, PLAYER_ANIMS);
}

/** Регистрирует анимации игрока (вызывается в Preloader после загрузки). */
export function createPlayerAnimations(scene: Phaser.Scene): void {
  registerAnimations(scene, PLAYER_ANIMS);
}

// ---- Параметры игрока ----
const PLAYER_W = 48;
const PLAYER_H = 69;
const ROLL_H = 34; // высота тела во время переката
const MAX_HP = 100;

const RUN_SPEED = 500;

const ROLL_SPEED = 540;
const ROLL_DURATION = 320; // мс
const ROLL_COOLDOWN = 550; // мс от начала переката до следующего

const HURT_DURATION = 220; // оглушение после удара, мс
const HURT_KNOCKBACK = 260;
const INVULNERABLE_AFTER_HIT = 600; // неуязвимость после удара, мс

/** Если между ударами прошло больше — серия начинается с первого удара. */
const COMBO_RESET = 700;

/** Параметры одного удара катаной. */
interface AttackDef {
  state: PlayerAnimState;
  /** Длительность удара, мс. Пока он идёт, игрок не управляет движением. */
  duration: number;
  /** Момент от начала удара, когда наносится урон, мс (под кадр анимации). */
  hitAt: number;
  damage: number;
  /** Дальность удара перед игроком. */
  range: number;
  /** Начальная скорость рывка вперёд (затухает к концу удара). */
  lunge: number;
  /** Сила отбрасывания противника. */
  knockback: number;
}

/** Серия из трёх ударов: чередуются по нажатию Z. */
const ATTACKS: AttackDef[] = [
  {
    state: PlayerAnimState.Attack1,
    duration: 200,
    hitAt: 60,
    damage: 20,
    range: 50,
    lunge: 280,
    knockback: 170,
  },
  {
    state: PlayerAnimState.Attack2,
    duration: 200,
    hitAt: 60,
    damage: 20,
    range: 50,
    lunge: 280,
    knockback: 170,
  },
  {
    state: PlayerAnimState.Attack3,
    duration: 320,
    hitAt: 110,
    damage: 40,
    range: 66,
    lunge: 460,
    knockback: 360,
  },
];

/**
 * Игрок с катаной. Управление:
 *  ← / → — бег, Space — перекат, Z — удар (серия из трёх).
 */
export class Player extends Entity<PlayerAnimState> {
  /** Цели для ударов (противники). Задаёт сцена. */
  targets?: Phaser.GameObjects.Group;

  isRolling = false;
  isAttacking = false;

  private keys: {
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    roll: Phaser.Input.Keyboard.Key;
    attack: Phaser.Input.Keyboard.Key;
  };

  // Таймеры (игровое время, мс)
  private rollDir: 1 | -1 = 1;
  private rollEndsAt = 0;
  private rollReadyAt = 0;
  private hurtEndsAt = 0;
  private invulnerableUntil = 0;

  // Серия ударов
  private comboIndex = 0; // какой удар будет следующим (0..2)
  private comboResetAt = 0;
  private attack?: AttackDef; // текущий удар
  private attackStartedAt = 0;
  private attackHitDone = false;
  private attackQueued = false; // Z нажата во время удара — следующий удар начнётся сразу

  /**
   * @param x — центр игрока по X
   * @param feetY — Y уровня пола
   */
  constructor(scene: Phaser.Scene, x: number, feetY: number) {
    super(
      scene,
      x,
      feetY,
      PLAYER_W,
      PLAYER_H,
      MAX_HP,
      PLAYER_ANIMS,
      PlayerAnimState.Idle,
      2,
    );

    this.setDepth(5);
    this.sprite?.setDepth(5);
    this.body.setCollideWorldBounds(true);
    this.body.setDragX(1400); // гасит отбрасывание, когда скорость не задаётся вручную

    const kb = scene.input.keyboard!;
    const K = Phaser.Input.Keyboard.KeyCodes;
    this.keys = {
      left: kb.addKey(K.LEFT),
      right: kb.addKey(K.RIGHT),
      roll: kb.addKey(K.SPACE),
      attack: kb.addKey(K.Z),
    };
  }

  /** Игрок не получает урон во время переката и сразу после удара. */
  get isInvulnerable(): boolean {
    return this.isRolling || this.scene.time.now < this.invulnerableUntil;
  }

  // ------------------------------------------------------------------
  // Главный update (вызывается из сцены каждый кадр)
  // ------------------------------------------------------------------

  update(time: number): void {
    if (this.isDead) {
      this.syncSprite();
      return;
    }

    const dir =
      (this.keys.right.isDown ? 1 : 0) - (this.keys.left.isDown ? 1 : 0);
    const attackPressed = Phaser.Input.Keyboard.JustDown(this.keys.attack);
    const rollPressed = Phaser.Input.Keyboard.JustDown(this.keys.roll);

    if (time < this.hurtEndsAt) {
      // Оглушён: не управляем, отбрасывание гасится drag'ом
    } else if (this.isRolling) {
      this.updateRoll(time);
    } else if (this.isAttacking) {
      if (attackPressed) this.attackQueued = true;
      this.updateAttack(time, dir);
    } else if (attackPressed) {
      this.startAttack(time, dir);
    } else if (rollPressed && time >= this.rollReadyAt) {
      this.startRoll(time, dir);
    } else {
      this.body.setVelocityX(dir * RUN_SPEED);
      if (dir !== 0) this.facing = dir as 1 | -1;
    }

    // Мигание во время неуязвимости после удара
    const blinking = time < this.invulnerableUntil && !this.isRolling;
    this.setVisualAlpha(blinking && Math.floor(time / 60) % 2 === 0 ? 0.35 : 1);

    this.updateAnimation(time, dir);
    this.syncSprite();
  }

  // ------------------------------------------------------------------
  // Перекат
  // ------------------------------------------------------------------

  private startRoll(time: number, dir: number): void {
    this.isRolling = true;
    this.rollDir = dir !== 0 ? (dir as 1 | -1) : this.facing;
    this.facing = this.rollDir;
    this.rollEndsAt = time + ROLL_DURATION;
    this.rollReadyAt = time + ROLL_COOLDOWN;
    this.setBodyHeight(ROLL_H);
    this.body.setVelocityX(this.rollDir * ROLL_SPEED);
  }

  private updateRoll(time: number): void {
    if (time >= this.rollEndsAt) {
      this.endRoll();
    } else {
      this.body.setVelocityX(this.rollDir * ROLL_SPEED);
    }
  }

  private endRoll(): void {
    if (!this.isRolling) return;
    this.isRolling = false;
    this.setBodyHeight(PLAYER_H);
  }

  // ------------------------------------------------------------------
  // Удары катаной
  // ------------------------------------------------------------------

  /** Начинает следующий удар серии. Нажатая стрелка разворачивает игрока перед ударом. */
  private startAttack(time: number, dir: number): void {
    if (time > this.comboResetAt) this.comboIndex = 0;
    if (dir !== 0) this.facing = dir as 1 | -1;

    this.attack = ATTACKS[this.comboIndex];
    this.comboIndex = (this.comboIndex + 1) % ATTACKS.length;

    this.isAttacking = true;
    this.attackStartedAt = time;
    this.attackHitDone = false;
    this.attackQueued = false;
    this.body.setVelocityX(this.facing * this.attack.lunge);
  }

  /** Рывок вперёд с затуханием, нанесение урона в момент hitAt, переход к следующему удару. */
  private updateAttack(time: number, dir: number): void {
    const atk = this.attack!;
    const elapsed = time - this.attackStartedAt;
    const progress = Math.min(1, elapsed / atk.duration);

    // Рывок после удара: скорость плавно падает до нуля к концу удара
    this.body.setVelocityX(
      this.facing * atk.lunge * (1 - progress) * (1 - progress),
    );

    if (!this.attackHitDone && elapsed >= atk.hitAt) {
      this.attackHitDone = true;
      this.hitTargets(atk);
    }

    if (elapsed >= atk.duration) {
      this.isAttacking = false;
      this.comboResetAt = time + COMBO_RESET;
      if (this.attackQueued) this.startAttack(time, dir);
    }
  }

  /** Наносит урон всем целям в зоне перед игроком и коротко показывает зону удара. */
  private hitTargets(atk: AttackDef): void {
    const hitType = ATTACKS.indexOf(atk); // 0, 1, 2 — какой удар серии попал
    const left = this.facing > 0 ? this.x : this.x - atk.range - this.width / 2;
    const box = new Phaser.Geom.Rectangle(
      left,
      this.y - this.height / 2 - 4,
      atk.range + this.width / 2,
      this.height + 8,
    );

    for (const child of this.targets?.getChildren() ?? []) {
      if (!(child instanceof Entity) || child.isDead) continue;
      if (Phaser.Geom.Intersects.RectangleToRectangle(box, child.getBounds())) {
        child.takeDamage(atk.damage, this.x, hitType);
        child.body.setVelocityX(this.facing * atk.knockback);
      }
    }

    // Временная вспышка зоны удара (потом заменится эффектом взмаха)
    const slash = this.scene.add
      .rectangle(
        box.centerX,
        box.centerY,
        box.width,
        box.height,
        0xffffff,
        0.25,
      )
      .setDepth(6);
    this.scene.tweens.add({
      targets: slash,
      alpha: 0,
      duration: 120,
      onComplete: () => slash.destroy(),
    });
  }

  // ------------------------------------------------------------------
  // Урон / смерть
  // ------------------------------------------------------------------

  override takeDamage(
    amount: number,
    sourceX: number = this.x,
    hitType: number = 0,
  ): void {
    if (this.isInvulnerable) return;
    super.takeDamage(amount, sourceX, hitType);
  }

  /** Получил урон: прерываем удар, отбрасываем от врага, даём короткую неуязвимость. */
  protected override onDamaged(
    _amount: number,
    sourceX: number,
    _hitType: number,
  ): void {
    const time = this.scene.time.now;
    this.isAttacking = false;
    this.attackQueued = false;
    this.hurtEndsAt = time + HURT_DURATION;
    this.invulnerableUntil = time + INVULNERABLE_AFTER_HIT;
    this.body.setVelocityX((this.x >= sourceX ? 1 : -1) * HURT_KNOCKBACK);
  }

  /** Смерть: сбрасываем действия, включаем анимацию смерти, сообщаем сцене. */
  protected override die(sourceX: number, hitType: number): void {
    super.die(sourceX, hitType);
    this.isAttacking = false;
    this.endRoll();
    this.setVisualAlpha(1);
    this.setAnimState(PlayerAnimState.Death);
    this.scene.events.emit("player-dead");
  }

  // ------------------------------------------------------------------
  // Анимации
  // ------------------------------------------------------------------

  /** Выбирает состояние анимации по тому, что сейчас делает игрок. */
  private updateAnimation(time: number, dir: number): void {
    let next: PlayerAnimState;

    if (time < this.hurtEndsAt) next = PlayerAnimState.Hurt;
    else if (this.isRolling) next = PlayerAnimState.Roll;
    else if (this.isAttacking) next = this.attack!.state;
    else if (dir !== 0) next = PlayerAnimState.Run;
    else next = PlayerAnimState.Idle;

    this.setAnimState(next);
  }
}
