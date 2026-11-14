import { Scene } from "phaser";
import { createEnemyAnimations, loadEnemySheets } from "../entities/Enemy";
import { createPlayerAnimations, loadPlayerSheets } from "../entities/Player";

export class Preloader extends Scene {
  constructor() {
    super("Preloader");
  }

  init() {
    // text loader
    // creating text object
    const textObject = this.add
      .text(1720, 900, "|", {
        fontSize: "120px",
        fontFamily: "PIXY",
        color: "#bfbfbf",
      })
      .setOrigin(0.5);

    // array of animation frames
    const frames = ["|", "/", "-", "\\"];
    let index = 0;

    // creating timer
    this.time.addEvent({
      delay: 200, // speed of changing frames
      callback: () => {
        index = (index + 1) % frames.length;
        textObject.setText(frames[index]);
      },
      loop: true,
    });

    this.load.on("complete", () => {
      textObject.destroy();
      createPlayerAnimations(this);
      createEnemyAnimations(this);
      this.scene.start("Game");
    });
  }

  preload() {
    this.load.setPath("assets");

    // Спрайт-листы анимаций: файлы и размеры кадров задаются полем sheet
    // в PLAYER_ANIMS (Player.ts) и ENEMY_ANIMS (Enemy.ts)
    loadPlayerSheets(this);
    loadEnemySheets(this);
  }

  create() {
    // this.scene.start("MainMenu");
  }
}
