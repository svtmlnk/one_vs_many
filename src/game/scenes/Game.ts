import * as Phaser from "phaser";
import { Enemy } from "../entities/Enemy";
import { Player } from "../entities/Player";

// ---- Кадр (чёрные полосы как в концепт-арте) ----
/** Высота чёрной полосы сверху и снизу, px игры (1920×1080). */
const LETTERBOX_H = 250;
const CAMERA_ZOOM = 2;
/** Где по высоте кадра стоят ноги игрока: 0 — верх, 1 — низ (в концепте ≈ 0.77). */
const FEET_ON_SCREEN = 0.77;
/** Плавность камеры по X. По Y камера не двигается. */
const CAMERA_LERP_X = 0.15;

// ---- Арена ----
const WORLD_W = 1920;
const WORLD_H = 500; // земля + запас снизу, чтобы кадр не упирался в границу мира
const GROUND_Y = 400; // верх земли

const GROUND_COLOR = 0x13222a;

// ---- Параллакс-горы ----
/** Вершина горы в игровых координатах. Двигай точки, чтобы менять форму и высоту. */
interface MountainPeak {
  x: number;
  y: number;
}

/**
 * Один слой параллакса.
 * x и width — занимаемая область; baseY — линия, к которой замыкается силуэт;
 * scrollFactor — скорость слоя относительно камеры: меньше 1 — дальний план,
 * больше 1 — передний план, закрывающий персонажей.
 */
interface ParallaxMountainLayer {
  name: string;
  color: number;
  alpha: number;
  depth: number;
  scrollFactor: number;
  x: number;
  width: number;
  baseY: number;
  /** Вершины слева направо. Крайние края дополнительно соединяются с baseY. */
  peaks: MountainPeak[];
}

/**
 * Три редактируемых слоя из примера. После добавления PNG замените createMountainLayer
 * на this.add.image(...) с теми же x/baseY/scrollFactor/depth — остальную настройку менять не придётся.
 */
const PARALLAX_MOUNTAINS: ParallaxMountainLayer[] = [
  {
    name: "Гора 1",
    color: 0xed1c24,
    alpha: 1,
    depth: -20,
    scrollFactor: 0.45,
    x: -150,
    width: 2220,
    baseY: GROUND_Y,
    peaks: [
      { x: 100, y: 272 },
      { x: 500, y: 315 },
      { x: 900, y: 290 },
      { x: 1300, y: 325 },
      { x: 1700, y: 280 },
      { x: 2100, y: 340 },
    ],
  },
  {
    name: "Гора 2",
    color: 0xff8617,
    alpha: 1,
    depth: -10,
    scrollFactor: 0.7,
    x: -150,
    width: 2220,
    baseY: GROUND_Y,
    peaks: [
      { x: 250, y: 340 },
      { x: 650, y: 385 },
      { x: 1050, y: 330 },
      { x: 1450, y: 380 },
      { x: 1850, y: 350 },
    ],
  },
  {
    name: "Гора 3",
    color: 0x3d3ec8,
    alpha: 1,
    depth: 10,
    scrollFactor: 1.15,
    x: -300,
    width: 2700,
    baseY: GROUND_Y + 250,
    peaks: [
      { x: 100, y: 300 },
      { x: 450, y: 420 },
      { x: 800, y: 330 },
      { x: 1150, y: 470 },
      { x: 1500, y: 340 },
      { x: 1850, y: 430 },
      { x: 2200, y: 350 },
    ],
  },
];

// ---- Волна противников ----
const KILL_TARGET = 30; // сколько нужно убить для победы (столько всего и появится)
const MAX_ALIVE = 8; // одновременно живых на арене
const SPAWN_DELAY = 900; // пауза между появлениями, мс
const SPAWN_EDGE_OFFSET = 20; // отступ от края карты при появлении

/** Основная сцена: арена, игрок, противники с краёв карты. */
export class Game extends Phaser.Scene {
  private player!: Player;
  private enemies!: Phaser.GameObjects.Group;
  /** Точка, за которой следит камера: X игрока на уровне земли (камера не прыгает вместе с ним). */
  private cameraTarget = new Phaser.Math.Vector2();

  private kills = 0;
  private spawned = 0;
  private isOver = false;

  private hudText!: Phaser.GameObjects.Text;

  constructor() {
    super("Game");
  }

  create() {
    this.kills = 0;
    this.spawned = 0;
    this.isOver = false;

    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H);

    this.createParallaxMountains();

    // Земля — статичное тело во всю ширину арены
    const ground = this.add.rectangle(
      WORLD_W / 2,
      (GROUND_Y + WORLD_H) / 2,
      WORLD_W,
      WORLD_H - GROUND_Y,
      GROUND_COLOR,
    );
    ground.setDepth(-5);
    this.physics.add.existing(ground, true);

    this.player = new Player(this, WORLD_W / 2, GROUND_Y);
    this.enemies = this.add.group();
    this.player.targets = this.enemies;

    this.physics.add.collider(this.player, ground);
    this.physics.add.collider(this.enemies, ground);

    this.setupCamera();

    this.hudText = this.addScreenText(40, 30, "", 40).setOrigin(0, 0);
    this.updateHud();

    this.time.addEvent({
      delay: SPAWN_DELAY,
      loop: true,
      callback: () => this.trySpawnEnemy(),
    });

    const onKill = () => this.onEnemyKilled();
    const onPlayerDead = () => this.endGame("ВЫ ПОГИБЛИ");
    this.events.on("enemy-killed", onKill);
    this.events.on("player-dead", onPlayerDead);
    // События сцены переживают restart — снимаем подписки при выключении сцены
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.events.off("enemy-killed", onKill);
      this.events.off("player-dead", onPlayerDead);
    });

    this.input.keyboard!.on("keydown-R", () => {
      if (this.isOver) this.scene.restart();
    });

    // работа с задним фоном в виде градиента
    const width = this.scale.width;
    const height = this.scale.height;
    const halfHeight = height / 2;

    const bg = this.add.graphics().setScrollFactor(0).setDepth(-100);

    bg.fillGradientStyle(0x541108, 0x541108, 0xa5220f, 0xa5220f, 1);
    bg.fillRect(0, 0, width, halfHeight);
  }

  update(time: number) {
    this.player.update(time);
    for (const enemy of this.enemies.getChildren() as Enemy[]) {
      enemy.update(time);
    }
    this.cameraTarget.x = this.player.x;
    this.updateHud();
  }

  // ------------------------------------------------------------------
  // Параллакс
  // ------------------------------------------------------------------

  /**
   * Рисует горы из PARALLAX_MOUNTAINS. Первые два слоя находятся за землёй
   * (depth < глубины земли), третий — перед персонажами (depth > глубины игрока).
   */
  private createParallaxMountains(): void {
    for (const layer of PARALLAX_MOUNTAINS) {
      const mountain = this.add.graphics()
        .setDepth(layer.depth)
        .setScrollFactor(layer.scrollFactor);

      mountain.fillStyle(layer.color, layer.alpha);
      mountain.beginPath();
      mountain.moveTo(layer.x, layer.baseY);
      for (const peak of layer.peaks) mountain.lineTo(peak.x, peak.y);
      mountain.lineTo(layer.x + layer.width, layer.baseY);
      mountain.closePath();
      mountain.fillPath();
    }
  }

  // ------------------------------------------------------------------
  // Камера
  // ------------------------------------------------------------------

  /**
   * Камера рисует только полосу кадра между чёрными полосами (за её пределами — чёрный фон игры),
   * следит за игроком только по X (в прыжке не поднимается) с зумом 2.
   */
  private setupCamera(): void {
    const cam = this.cameras.main;
    cam.setViewport(
      0,
      LETTERBOX_H,
      this.scale.width,
      this.scale.height - LETTERBOX_H * 2,
    );
    // cam.setBackgroundColor(SKY_COLOR);
    cam.setBounds(0, 0, WORLD_W, WORLD_H);
    cam.setZoom(CAMERA_ZOOM);

    // Смещение, чтобы земля (ноги игрока) была на FEET_ON_SCREEN высоты кадра, а не в центре
    const viewH = cam.height / CAMERA_ZOOM;
    const offsetY = (FEET_ON_SCREEN - 0.5) * viewH;

    this.cameraTarget.set(this.player.x, GROUND_Y);
    cam.startFollow(this.cameraTarget, true, CAMERA_LERP_X, 0, 0, offsetY);
  }

  // ------------------------------------------------------------------
  // Противники
  // ------------------------------------------------------------------

  /** Создаёт противника на случайном краю карты, если не превышен лимит. */
  private trySpawnEnemy(): void {
    if (this.isOver || this.spawned >= KILL_TARGET) return;

    const alive = (this.enemies.getChildren() as Enemy[]).filter(
      (e) => !e.isDead,
    ).length;
    if (alive >= MAX_ALIVE) return;

    const x =
      Math.random() < 0.5 ? SPAWN_EDGE_OFFSET : WORLD_W - SPAWN_EDGE_OFFSET;
    const enemy = new Enemy(this, x, GROUND_Y, this.player);
    this.enemies.add(enemy);
    this.spawned++;
  }

  private onEnemyKilled(): void {
    this.kills++;
    if (this.kills >= KILL_TARGET && !this.player.isDead)
      this.endGame("ПОБЕДА");
  }

  // ------------------------------------------------------------------
  // Интерфейс (всё рисуется внутри кадра камеры, на чёрные полосы не заходит)
  // ------------------------------------------------------------------

  private updateHud(): void {
    this.hudText.setText(
      `HP ${this.player.hp}    Убито ${this.kills}/${KILL_TARGET}`,
    );
  }

  private endGame(title: string): void {
    if (this.isOver) return;
    this.isOver = true;

    const cam = this.cameras.main;
    this.addScreenText(cam.width / 2, cam.height / 2 - 40, title, 96);
    this.addScreenText(
      cam.width / 2,
      cam.height / 2 + 50,
      "R — начать заново",
      40,
    );
  }

  /**
   * Переводит координаты кадра камеры в координаты объекта со scrollFactor 0.
   * Камера с зумом увеличивает и такие объекты (относительно центра кадра),
   * поэтому позицию и масштаб нужно пересчитать под зум.
   */
  private toScreen(sx: number, sy: number): { x: number; y: number } {
    const cam = this.cameras.main;
    const cx = cam.width / 2;
    const cy = cam.height / 2;
    return { x: cx + (sx - cx) / cam.zoom, y: cy + (sy - cy) / cam.zoom };
  }

  /**
   * Текст, закреплённый в кадре.
   * @param sx, sy — координаты внутри кадра камеры (0,0 — левый верхний угол кадра, без полос)
   */
  private addScreenText(
    sx: number,
    sy: number,
    text: string,
    size: number,
  ): Phaser.GameObjects.Text {
    const { x, y } = this.toScreen(sx, sy);
    return this.add
      .text(x, y, text, {
        fontFamily: "monospace",
        fontSize: `${size}px`,
        color: "#ffffff",
      })
      .setOrigin(0.5)
      .setScale(1 / this.cameras.main.zoom)
      .setScrollFactor(0)
      .setDepth(100);
  }
}
