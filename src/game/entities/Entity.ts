import * as Phaser from 'phaser';

/** Спрайт-лист одной анимации (кадры в один ряд или сеткой). */
export interface SpriteSheetDef {
    /** Файл в public/assets. */
    file: string;
    frameWidth: number;
    frameHeight: number;
    /** Масштаб спрайта, чтобы персонаж совпал по росту с физическим телом. По умолчанию 1. */
    scale?: number;
}

/** Описание одной анимации + цвет заглушки для этого состояния. */
export interface AnimDef {
    /** Уникальный ключ анимации в Phaser. */
    key: string;
    /** Спрайт-лист анимации. Пока не указан — состояние рисуется прямоугольником-заглушкой. */
    sheet?: SpriteSheetDef;
    /** Первый кадр в спрайт-листе (по умолчанию — первый). */
    start?: number;
    /** Последний кадр в спрайт-листе (по умолчанию — последний). */
    end?: number;
    /** Скорость, кадров в секунду. */
    frameRate: number;
    /** Повторы: -1 = бесконечно, 0 = один раз. */
    repeat: number;
    /** Цвет прямоугольника-заглушки, пока нет спрайта. Помогает видеть смену состояний. */
    color: number;
}

/** Набор анимаций сущности: по одной на каждое состояние. */
export type AnimSet<S extends string> = Record<S, AnimDef>;

/**
 * Ставит в очередь загрузки спрайт-листы всех анимаций, у которых указан sheet (вызывается в Preloader.preload).
 * Ключ текстуры — имя файла, поэтому несколько анимаций могут брать разные кадры из одного листа.
 */
export function loadAnimationSheets(scene: Phaser.Scene, anims: AnimSet<string>): void {
    const queued = new Set<string>();
    for (const def of Object.values(anims)) {
        if (!def.sheet || queued.has(def.sheet.file)) continue;
        queued.add(def.sheet.file);
        scene.load.spritesheet(def.sheet.file, def.sheet.file, {
            frameWidth: def.sheet.frameWidth,
            frameHeight: def.sheet.frameHeight,
        });
    }
}

/**
 * Регистрирует анимации в менеджере анимаций Phaser (вызывается после загрузки).
 * Анимации без загруженного спрайт-листа пропускаются — для них остаётся заглушка.
 */
export function registerAnimations(scene: Phaser.Scene, anims: AnimSet<string>): void {
    for (const def of Object.values(anims)) {
        if (!def.sheet || !scene.textures.exists(def.sheet.file) || scene.anims.exists(def.key)) continue;

        scene.anims.create({
            key: def.key,
            // -1 у Phaser значит «до последнего кадра»; undefined передавать нельзя — он не заменится на значение по умолчанию
            frames: scene.anims.generateFrameNumbers(def.sheet.file, { start: def.start ?? 0, end: def.end ?? -1 }),
            frameRate: def.frameRate,
            repeat: def.repeat,
        });
    }
}

/**
 * Базовая сущность: прямоугольник с физическим телом, здоровьем и машиной состояний анимации.
 * Для состояний, у которых есть спрайт-анимация, поверх тела рисуется спрайт (прямоугольник скрыт).
 * Для остальных — прямоугольник-заглушка, цвет которого меняется по состоянию.
 * Так спрайты можно добавлять по одному, не ломая остальные состояния.
 */
export class Entity<S extends string = string> extends Phaser.GameObjects.Rectangle {
    // Уточняем тип тела: у сущности всегда есть Arcade-физика
    declare body: Phaser.Physics.Arcade.Body;

    /** Максимальное здоровье. */
    readonly maxHp: number;
    /** Текущее здоровье. При 0 сущность мертва. */
    hp: number;
    /** Куда смотрит сущность: 1 — вправо, -1 — влево. */
    facing: 1 | -1 = 1;
    /** Текущее состояние анимации. */
    animState: S;

    /** Ширина тела стоя (нужна при изменении высоты тела). */
    protected readonly standW: number;
    /** Спрайт. Виден только в состояниях, у которых есть спрайт-анимация. */
    protected sprite: Phaser.GameObjects.Sprite;

    private readonly animSet: AnimSet<S>;
    private flashTimer?: Phaser.Time.TimerEvent;

    /**
     * @param x — центр по X
     * @param feetY — Y уровня пола (куда встают ноги)
     * @param width, height — размеры тела
     * @param maxHp — максимальное и стартовое здоровье
     * @param animSet — анимации по состояниям
     * @param initialState — стартовое состояние
     * @param scale — общий масштаб отображаемого тела, хитбокса и спрайта
     */
    constructor(
        scene: Phaser.Scene,
        x: number,
        feetY: number,
        width: number,
        height: number,
        maxHp: number,
        animSet: AnimSet<S>,
        initialState: S,
        scale: number = 1
    ) {
        super(scene, x, feetY - (height * scale) / 2, width, height, animSet[initialState].color);
        scene.add.existing(this);
        scene.physics.add.existing(this);
        // Arcade Physics учитывает scaleX/scaleY и автоматически увеличивает хитбокс.
        this.setScale(scale);
        this.body.updateBounds();
        this.body.reset(x, this.y);

        this.maxHp = maxHp;
        this.hp = maxHp;
        this.standW = width;
        this.animSet = animSet;
        this.animState = initialState;

        this.sprite = scene.add.sprite(x, feetY, '__DEFAULT').setOrigin(0.5, 1);
        this.applyVisual();
    }

    /** true, если здоровье закончилось. */
    get isDead(): boolean {
        return this.hp <= 0;
    }

    /** Стоит ли сущность на земле. */
    get onGround(): boolean {
        return this.body.blocked.down || this.body.touching.down;
    }

    /**
     * Наносит урон. Игнорируется, если сущность уже мертва или урон <= 0.
     * @param sourceX — X источника урона (для отбрасывания в нужную сторону)
     * @param hitType — номер удара в серии атакующего (0, 1, 2) — для выбора анимации получения урона
     */
    takeDamage(amount: number, sourceX: number = this.x, hitType: number = 0): void {
        if (this.isDead || amount <= 0) return;

        this.hp = Math.max(0, this.hp - amount);

        if (this.hp === 0) {
            this.die(sourceX, hitType);
        } else {
            this.onDamaged(amount, sourceX, hitType);
        }
    }

    /** Хук для наследников: сущность получила урон, но выжила. */
    protected onDamaged(_amount: number, _sourceX: number, _hitType: number): void {}

    /** Вызывается один раз, когда HP достигло 0. Наследники расширяют (super.die()). */
    protected die(_sourceX: number, _hitType: number): void {
        this.body.setVelocityX(0);
    }

    // ------------------------------------------------------------------
    // Анимация / визуал
    // ------------------------------------------------------------------

    /** Переключает состояние: запускает анимацию спрайта или перекрашивает заглушку. */
    protected setAnimState(next: S): void {
        if (next === this.animState) return;
        this.animState = next;
        this.applyVisual();
    }

    /** Есть ли у состояния спрайт-анимация (иначе рисуется прямоугольник-заглушка). */
    protected hasSpriteAnim(state: S = this.animState): boolean {
        return this.scene.anims.exists(this.animSet[state].key);
    }

    /** Запускает анимацию текущего состояния заново (например, повторный удар тем же типом). */
    protected restartAnim(): void {
        if (this.hasSpriteAnim()) this.sprite.play(this.animSet[this.animState].key, false);
    }

    /** Показывает спрайт с анимацией текущего состояния или прямоугольник-заглушку. */
    private applyVisual(): void {
        const def = this.animSet[this.animState];
        const useSprite = this.hasSpriteAnim();

        this.setVisible(!useSprite);
        this.sprite.setVisible(useSprite);

        if (useSprite) {
            this.sprite.setScale((def.sheet?.scale ?? 1) * this.scaleX);
            this.sprite.play(def.key, true);
        } else {
            this.sprite.stop();
            if (!this.flashTimer) this.setFillStyle(def.color);
        }
    }

    /** Короткая вспышка цветом (например, белым при получении урона). */
    protected flash(color: number, duration: number): void {
        this.flashTimer?.remove();
        this.setFillStyle(color);
        this.sprite?.setTint(color);
        if (this.sprite) this.sprite.tintFill = true;

        this.flashTimer = this.scene.time.delayedCall(duration, () => {
            this.flashTimer = undefined;
            if (!this.active) return;
            this.setFillStyle(this.animSet[this.animState].color);
            this.sprite?.clearTint();
            if (this.sprite) this.sprite.tintFill = false;
        });
    }

    /** Прозрачность и прямоугольника, и спрайта. */
    protected setVisualAlpha(alpha: number): void {
        this.setAlpha(alpha);
        this.sprite?.setAlpha(alpha);
    }

    /** Двигает спрайт вместе с телом и отражает его по направлению взгляда. */
    protected syncSprite(): void {
        if (!this.sprite) return;
        this.sprite.setPosition(this.x, this.body.bottom);
        this.sprite.setFlipX(this.facing < 0);
    }

    /** Меняет высоту тела, сохраняя положение ног на полу (перекат, труп). */
    protected setBodyHeight(h: number): void {
        const feetY = this.body.bottom;
        this.setSize(this.standW, h);
        this.body.setSize(this.standW, h);
        this.y = feetY - (h * this.scaleY) / 2;
        this.body.reset(this.x, this.y);
    }

    /** Вместе с сущностью удаляем спрайт и таймер вспышки. */
    override destroy(fromScene?: boolean): void {
        this.flashTimer?.remove();
        this.sprite?.destroy();
        super.destroy(fromScene);
    }
}
