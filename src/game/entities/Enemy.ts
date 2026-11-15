import * as Phaser from 'phaser';
import { AnimSet, Entity, loadAnimationSheets, registerAnimations } from './Entity';
import { Player } from './Player';

/** Все состояния анимации противника. */
export enum EnemyAnimState {
    Idle = 'idle',
    Run = 'run',
    /** Три вида атаки противника (выбираются случайно). */
    Attack1 = 'attack1',
    Attack2 = 'attack2',
    Attack3 = 'attack3',
    /** Три вида получения урона — по номеру удара катаны в серии игрока (1, 2, 3). */
    Hurt1 = 'hurt1',
    Hurt2 = 'hurt2',
    Hurt3 = 'hurt3',
    Death = 'death',
}

/**
 * Анимации противника: каждый файл в sprites/enemy содержит один кадр 256×256.
 * Для трёх состояний получения урона используется общий спрайт e_damage.png.
 */
const ENEMY_SPRITE_SCALE = 0.3;
const enemySheet = (file: string) => ({
    file: `sprites/enemy/${file}`,
    frameWidth: 256,
    frameHeight: 256,
    scale: ENEMY_SPRITE_SCALE,
});

export const ENEMY_ANIMS: AnimSet<EnemyAnimState> = {
    [EnemyAnimState.Idle]: { key: 'enemy-idle', sheet: enemySheet('e_calm.png'), frameRate: 1, repeat: 0, color: 0x151515 },
    [EnemyAnimState.Run]: { key: 'enemy-run', sheet: enemySheet('e_run.png'), frameRate: 1, repeat: 0, color: 0x151515 },
    [EnemyAnimState.Attack1]: { key: 'enemy-attack1', sheet: enemySheet('e_attack1.png'), frameRate: 1, repeat: 0, color: 0x5a1010 },
    [EnemyAnimState.Attack2]: { key: 'enemy-attack2', sheet: enemySheet('e_attack2.png'), frameRate: 1, repeat: 0, color: 0x6e1a3a },
    [EnemyAnimState.Attack3]: { key: 'enemy-attack3', sheet: enemySheet('e_attack3.png'), frameRate: 1, repeat: 0, color: 0x7a3a0a },
    [EnemyAnimState.Hurt1]: { key: 'enemy-hurt1', sheet: enemySheet('e_damage.png'), frameRate: 1, repeat: 0, color: 0x3a3a3a },
    [EnemyAnimState.Hurt2]: { key: 'enemy-hurt2', sheet: enemySheet('e_damage.png'), frameRate: 1, repeat: 0, color: 0x4a4a4a },
    [EnemyAnimState.Hurt3]: { key: 'enemy-hurt3', sheet: enemySheet('e_damage.png'), frameRate: 1, repeat: 0, color: 0x5c5c5c },
    [EnemyAnimState.Death]: { key: 'enemy-death', sheet: enemySheet('e_death.png'), frameRate: 1, repeat: 0, color: 0x0b0b0b },
};

/** Анимация получения урона по номеру удара игрока (0, 1, 2). */
const HURT_STATES = [EnemyAnimState.Hurt1, EnemyAnimState.Hurt2, EnemyAnimState.Hurt3];

/** Ставит в очередь загрузки спрайт-листы противника (вызывается в Preloader.preload). */
export function loadEnemySheets(scene: Phaser.Scene): void {
    loadAnimationSheets(scene, ENEMY_ANIMS);
}

/** Регистрирует анимации противника (вызывается в Preloader после загрузки). */
export function createEnemyAnimations(scene: Phaser.Scene): void {
    registerAnimations(scene, ENEMY_ANIMS);
}

// ---- Параметры противника ----
const ENEMY_W = 48;
const ENEMY_H = 69;
const ENEMY_MAX_HP = 40;

const SPEED_MIN = 150;
const SPEED_MAX = 220;

/** Расстояние (между краями тел), с которого противник начинает атаку. Случайное — чтобы толпа не слипалась. */
const ATTACK_GAP_MIN = 4;
const ATTACK_GAP_MAX = 40;
const ATTACK_COOLDOWN = 700; // пауза после атаки, мс

/** Параметры одного вида атаки противника. */
interface EnemyAttackDef {
    state: EnemyAnimState;
    /** Замах: время от начала атаки до удара, мс (игрок успевает среагировать). */
    windup: number;
    /** Вся атака целиком, мс. */
    duration: number;
    damage: number;
    /** Дальность удара перед собой. */
    reach: number;
}

/** Три вида атаки: каждый раз выбирается случайный. */
const ATTACKS: EnemyAttackDef[] = [
    { state: EnemyAnimState.Attack1, windup: 380, duration: 600, damage: 10, reach: 56 },
    { state: EnemyAnimState.Attack2, windup: 300, duration: 520, damage: 8, reach: 50 },
    { state: EnemyAnimState.Attack3, windup: 520, duration: 800, damage: 15, reach: 64 },
];

/** Оглушение после удара игрока, мс — по номеру удара (третий оглушает дольше). */
const HURT_DURATIONS = [240, 240, 380];
const CORPSE_LIFETIME = 700; // через сколько мс труп начинает исчезать

/**
 * Противник: бежит к игроку, на дистанции атаки останавливается и бьёт.
 * Получает урон от катаны, оглушается, при HP = 0 умирает.
 */
export class Enemy extends Entity<EnemyAnimState> {
    private readonly target: Player;
    private readonly speed: number;
    private readonly attackGap: number;

    private attack?: EnemyAttackDef; // текущая атака (undefined — не атакует)
    private attackStartedAt = 0;
    private attackStruck = false;
    private nextAttackAt = 0;
    private hurtEndsAt = 0;
    private hurtState = EnemyAnimState.Hurt1;

    /**
     * @param x — центр противника по X
     * @param feetY — Y уровня пола
     * @param target — игрок, за которым бежит противник
     */
    constructor(scene: Phaser.Scene, x: number, feetY: number, target: Player) {
        super(scene, x, feetY, ENEMY_W, ENEMY_H, ENEMY_MAX_HP, ENEMY_ANIMS, EnemyAnimState.Run, 2);

        this.target = target;
        this.speed = Phaser.Math.Between(SPEED_MIN, SPEED_MAX);
        this.attackGap = Phaser.Math.Between(ATTACK_GAP_MIN, ATTACK_GAP_MAX);

        this.setDepth(4);
        this.sprite?.setDepth(4);
        this.body.setCollideWorldBounds(true);
        this.body.setDragX(1200);
    }

    /** Обновление ИИ (вызывает сцена каждый кадр). */
    update(time: number): void {
        if (this.isDead) {
            this.syncSprite();
            return;
        }

        if (time < this.hurtEndsAt) {
            this.setAnimState(this.hurtState);
        } else if (this.attack) {
            this.updateAttack(time, this.attack);
        } else if (this.target.isDead) {
            this.body.setVelocityX(0);
            this.setAnimState(EnemyAnimState.Idle);
        } else {
            this.chase(time);
        }

        this.syncSprite();
    }

    // ------------------------------------------------------------------
    // ИИ
    // ------------------------------------------------------------------

    /** Бежит к игроку; если добежал — начинает атаку (когда прошла пауза). */
    private chase(time: number): void {
        const dx = this.target.x - this.x;
        this.facing = dx >= 0 ? 1 : -1;

        const gap = Math.abs(dx) - (this.width + this.target.width) / 2;
        if (gap > this.attackGap) {
            this.body.setVelocityX(this.facing * this.speed);
            this.setAnimState(EnemyAnimState.Run);
            return;
        }

        this.body.setVelocityX(0);
        if (time >= this.nextAttackAt) {
            this.attack = Phaser.Utils.Array.GetRandom(ATTACKS);
            this.attackStartedAt = time;
            this.attackStruck = false;
            this.setAnimState(this.attack.state);
        } else {
            this.setAnimState(EnemyAnimState.Idle);
        }
    }

    /** Замах → удар (урон, если игрок в зоне) → восстановление. */
    private updateAttack(time: number, atk: EnemyAttackDef): void {
        this.body.setVelocityX(0);
        const elapsed = time - this.attackStartedAt;

        if (!this.attackStruck && elapsed >= atk.windup) {
            this.attackStruck = true;
            if (!this.target.isDead && this.playerInReach(atk.reach)) {
                this.target.takeDamage(atk.damage, this.x);
            }
        }

        if (elapsed >= atk.duration) {
            this.attack = undefined;
            this.nextAttackAt = time + ATTACK_COOLDOWN;
        }
    }

    /** Пересекается ли игрок с зоной удара перед противником. */
    private playerInReach(reach: number): boolean {
        const left = this.facing > 0 ? this.x : this.x - this.width / 2 - reach;
        const box = new Phaser.Geom.Rectangle(left, this.y - this.height / 2, this.width / 2 + reach, this.height);
        return Phaser.Geom.Intersects.RectangleToRectangle(box, this.target.getBounds());
    }

    // ------------------------------------------------------------------
    // Урон / смерть
    // ------------------------------------------------------------------

    /** Получил удар: вспышка, оглушение (анимация зависит от удара игрока), атака прерывается. */
    protected override onDamaged(_amount: number, _sourceX: number, hitType: number): void {
        const type = Phaser.Math.Clamp(hitType, 0, HURT_STATES.length - 1);
        this.attack = undefined;
        this.hurtState = HURT_STATES[type];
        this.hurtEndsAt = this.scene.time.now + HURT_DURATIONS[type];
        this.nextAttackAt = this.hurtEndsAt + ATTACK_COOLDOWN / 2;
        this.flash(0xffffff, 70);
        // Перезапускаем анимацию, даже если противника бьют тем же ударом повторно
        this.setAnimState(this.hurtState);
        this.restartAnim();
    }

    /** Смерть: «укладываем» тело на пол, сообщаем сцене, через время труп исчезает. */
    protected override die(sourceX: number, hitType: number): void {
        super.die(sourceX, hitType);
        this.attack = undefined;
        this.setAnimState(EnemyAnimState.Death);
        this.flash(0xffffff, 70);
        if (!this.hasSpriteAnim()) this.setBodyHeight(14); // заглушка «лежит» на полу

        this.scene.events.emit('enemy-killed', this);

        this.scene.tweens.add({
            targets: [this, this.sprite],
            alpha: 0,
            delay: CORPSE_LIFETIME,
            duration: 400,
            onComplete: () => this.destroy(),
        });
    }
}
