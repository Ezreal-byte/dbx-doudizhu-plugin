import {Container, Graphics, Rectangle, Sprite, Texture} from 'pixi.js';
import {imageAsset, characterAtlas, CHARACTER_COUNT} from './assets';

type Point = readonly [number, number];
type Rig = {
  shoulder: readonly [number, number, number];
  neck: Point;
  headPivot: Point;
  screenLeftArmRow: 2 | 3;
  row2Pivot: Point;
  row3Pivot: Point;
  row2Elbow: Point;
  row3Elbow: Point;
  handToChin: Point;
  eyes: readonly Point[];
  skin: number;
  sleeve: number;
  headHeight: number;
};

// Coordinates refer to the tight alpha bounds, not the atlas cell. The shoulder
// belongs to the torso; the sprite rotates about the painted shoulder seam.
const rigs: readonly Rig[] = [
  {screenLeftArmRow: 3, handToChin: [.8, 1.7], shoulder: [.32, .32, .88], neck: [0, .97], headPivot: [.53, .98], row2Pivot: [.45, .065], row3Pivot: [.69, .065], row2Elbow: [.65, .49], row3Elbow: [.40, .49], eyes: [[.375, .65], [.675, .635]], skin: 0xf0bd9e, sleeve: 0xe3d4b3, headHeight: 171},
  {screenLeftArmRow: 3, handToChin: [.8, 1.7], shoulder: [.305, .305, .88], neck: [0, .97], headPivot: [.515, .985], row2Pivot: [.37, .07], row3Pivot: [.70, .065], row2Elbow: [.54, .49], row3Elbow: [.40, .49], eyes: [[.365, .645], [.65, .635]], skin: 0xf2c1a6, sleeve: 0xc76a48, headHeight: 166},
  {screenLeftArmRow: 3, handToChin: [.8, 1.7], shoulder: [.355, .34, .88], neck: [0, .97], headPivot: [.515, .985], row2Pivot: [.45, .065], row3Pivot: [.68, .065], row2Elbow: [.64, .49], row3Elbow: [.39, .49], eyes: [], skin: 0xf2be99, sleeve: 0xe0ceb0, headHeight: 169},
  {screenLeftArmRow: 3, handToChin: [.8, 1.7], shoulder: [.17, .24, .88], neck: [.04, .97], headPivot: [.515, .975], row2Pivot: [.43, .065], row3Pivot: [.67, .065], row2Elbow: [.61, .49], row3Elbow: [.40, .49], eyes: [[.326, .672], [.589, .616]], skin: 0xf2c1a6, sleeve: 0xe2d6ba, headHeight: 170},
  {screenLeftArmRow: 2, handToChin: [.6, 2.4], shoulder: [.275, .22, .88], neck: [-.05, .97], headPivot: [.485, .99], row2Pivot: [.48, .065], row3Pivot: [.54, .065], row2Elbow: [.54, .49], row3Elbow: [.47, .49], eyes: [[.357, .651], [.656, .659]], skin: 0xefbc99, sleeve: 0xe5d5b8, headHeight: 171},
];

export type CharacterParts = {textures: Texture[]; index: number};

function trimPart(sheet: Texture, image: HTMLImageElement, column: number, columns: number, row: number, rows: readonly number[]): Texture {
  const x = Math.round(column * image.width / columns);
  const y = Math.round(rows[row]! * image.height);
  const width = Math.round((column + 1) * image.width / columns) - x;
  const height = Math.round(rows[row + 1]! * image.height) - y;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.drawImage(image, x, y, width, height, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  let left = width, top = height, right = -1, bottom = -1;
  for (let yy = 0; yy < height; yy++) for (let xx = 0; xx < width; xx++) {
    if (pixels[(yy * width + xx) * 4 + 3]! > 90) {
      left = Math.min(left, xx); right = Math.max(right, xx);
      top = Math.min(top, yy); bottom = Math.max(bottom, yy);
    }
  }
  if (right < left || bottom < top) throw new Error(`角色素材缺少部件：${column + 1}/${row + 1}`);
  return new Texture({source: sheet.source, frame: new Rectangle(x + left, y + top, right - left + 1, bottom - top + 1)});
}

export async function loadCharacterParts(count = CHARACTER_COUNT): Promise<CharacterParts[]> {
  const sheets = new Map<string, Awaited<ReturnType<typeof imageAsset>>>();
  await Promise.all([...new Set(Array.from({length: count}, (_, index) => characterAtlas(index).path))].map(async path => {
    sheets.set(path, await imageAsset(path));
  }));
  return Array.from({length: count}, (_, index) => {
    const atlas = characterAtlas(index), sheet = sheets.get(atlas.path)!;
    return {index, textures: [0, 1, 2, 3].map(row => trimPart(sheet.texture, sheet.image, atlas.column, atlas.columns, row, atlas.rows))};
  });
}

class Arm {
  readonly shoulder = new Container();
  readonly elbow = new Container();
  constructor(texture: Texture, height: number, pivot: Point, hinge: Point, sleeveColor: number) {
    const width = texture.width, length = texture.height, scale = height / length;
    const lowerStart = Math.floor(length * .43), upperEnd = Math.ceil(length * .60);
    const upperTexture = new Texture({source: texture.source, frame: new Rectangle(texture.frame.x, texture.frame.y, width, upperEnd)});
    const lowerTexture = new Texture({source: texture.source, frame: new Rectangle(texture.frame.x, texture.frame.y + lowerStart, width, length - lowerStart)});
    const upper = new Sprite(upperTexture), lower = new Sprite(lowerTexture);
    upper.scale.set(scale); lower.scale.set(scale);
    upper.position.set(-pivot[0] * width * scale, -pivot[1] * length * scale);
    this.elbow.position.set((hinge[0] - pivot[0]) * width * scale, (hinge[1] - pivot[1]) * length * scale);
    lower.position.set(-hinge[0] * width * scale, (lowerStart - hinge[1] * length) * scale);
    // The overlap and small sleeve-coloured hinge remain underneath both painted
    // pieces. Flexing a forearm cannot expose a transparent hole at the elbow.
    const seam = new Graphics().circle(0, 0, width * scale * .22).fill(sleeveColor);
    this.elbow.addChild(seam, lower);
    this.shoulder.addChild(this.elbow, upper);
  }
}

type Pose = {left: number; right: number; leftElbow: number; rightElbow: number; head: number; nod: number; bounce: number; lean: number};
const ease = (x: number) => x * x * (3 - 2 * x);
const cap = (x: number) => Math.max(0, Math.min(1, x));

export class Character {
  readonly root = new Container();
  private readonly torso = new Container();
  private readonly headJoint = new Container();
  private readonly head: Sprite;
  private readonly body: Sprite;
  private readonly left: Arm;
  private readonly right: Arm;
  private readonly lids: Graphics;
  private readonly shadow: Graphics;
  private readonly rig: Rig;
  private readonly seed: number;
  private started = 0;
  private duration = 0;
  private motion = 'idle';
  baseline = 0;

  constructor(parts: CharacterParts, public readonly id: string, click: () => void) {
    this.rig = rigs[parts.index] ?? rigs[0]!;
    this.seed = [...id].reduce((sum, value) => (sum * 31 + value.charCodeAt(0)) % 997, 0) / 159;
    const [head, body, row2, row3] = parts.textures as [Texture, Texture, Texture, Texture];
    this.body = new Sprite(body); this.body.anchor.set(.5, 1);
    this.body.scale.set(225 / body.height);
    this.head = new Sprite(head); this.head.anchor.set(...this.rig.headPivot);
    this.head.scale.set(this.rig.headHeight / head.height);
    this.headJoint.position.set(this.rig.neck[0] * this.body.width, -225 * this.rig.neck[1]);
    this.headJoint.addChild(this.head);
    // Atlas rows describe painted parts, not a universal screen-left/right order.
    // For characters 0–3 row 3 is the anatomical right arm (screen left).
    // Chang'an's atlas column is the opposite: row 2 is his anatomical right arm.
    // Keep each texture with its own shoulder and elbow metadata when binding it.
    const atlasArms = {
      2: {texture: row2, pivot: this.rig.row2Pivot, elbow: this.rig.row2Elbow},
      3: {texture: row3, pivot: this.rig.row3Pivot, elbow: this.rig.row3Elbow},
    };
    const left = atlasArms[this.rig.screenLeftArmRow];
    const right = atlasArms[this.rig.screenLeftArmRow === 2 ? 3 : 2];
    this.left = new Arm(left.texture, 138, left.pivot, left.elbow, this.rig.sleeve);
    this.right = new Arm(right.texture, 138, right.pivot, right.elbow, this.rig.sleeve);
    this.left.shoulder.position.set(-this.body.width * this.rig.shoulder[0], -225 * this.rig.shoulder[2]);
    this.right.shoulder.position.set(this.body.width * this.rig.shoulder[1], -225 * this.rig.shoulder[2]);
    this.shadow = new Graphics().ellipse(0, -1, 61, 10).fill({color: 0x143025, alpha: .24});
    // Every articulated piece shares this torso transform. Breath and victory
    // bounces therefore carry the shoulder roots and the neck together.
    this.torso.addChild(this.body, this.left.shoulder, this.right.shoulder, this.headJoint);
    this.root.addChild(this.shadow, this.torso);
    this.root.eventMode = 'static'; this.root.cursor = 'pointer';
    this.root.on('pointertap', click);
    this.lids = new Graphics();
    const headWidth = this.head.width, headHeight = this.head.height;
    for (const eye of this.rig.eyes) {
      const x = (eye[0] - this.rig.headPivot[0]) * headWidth;
      const y = (eye[1] - this.rig.headPivot[1]) * headHeight;
      this.lids.ellipse(x, y, headWidth * .084, headHeight * .066).fill(this.rig.skin);
      this.lids.moveTo(x - headWidth * .063, y).quadraticCurveTo(x, y + 5, x + headWidth * .063, y).stroke({color: 0x664035, width: 1.7});
    }
    // Eyelids are local to the head joint and never float in scene coordinates.
    this.headJoint.addChild(this.lids); this.lids.visible = false;
  }

  act(kind: string, now: number) {
    this.motion = kind; this.started = now;
    this.duration = ['win', 'spring'].includes(kind) ? 3000 : kind === 'lose' ? 2400 : 1800;
  }

  tick(now: number, low: boolean, thinking: boolean) {
    const seconds = now / 1000 + this.seed, elapsed = now - this.started;
    const active = elapsed >= 0 && elapsed < this.duration ? this.motion : thinking ? 'thinking' : 'idle';
    const amount = low ? .25 : 1;
    const breath = Math.sin(seconds * 1.8);
    const pose: Pose = {left: .10, right: -.10, leftElbow: .025, rightElbow: -.025, head: Math.sin(seconds * .7) * .018, nod: 0, bounce: 0, lean: 0};
    const progress = cap(elapsed / Math.max(1, this.duration));
    const envelope = ease(Math.min(1, progress * 5)) * ease(Math.min(1, (1 - progress) * 4));
    const pulse = Math.sin(progress * Math.PI);
    const swing = Math.sin(seconds * 1.3) * .022;
    pose.left += swing; pose.right -= swing;
    if (active === 'thinking') {
      pose.right = this.rig.handToChin[0]; pose.rightElbow = this.rig.handToChin[1]; pose.head = -.04; pose.nod = -1;
    } else if (['play', 'bid', 'double', 'like', 'send'].includes(active)) {
      pose.right = -.10 - .45 * envelope;
      pose.rightElbow = -.48 * envelope - Math.sin(progress * Math.PI * 4) * .16 * envelope;
      pose.head = -.035 * pulse; pose.lean = -.012 * pulse;
    } else if (active === 'pass') {
      pose.right = -.10 - .18 * envelope; pose.rightElbow = -.18 * envelope;
      pose.head = Math.sin(progress * Math.PI * 3) * .05 * envelope;
      pose.nod = envelope;
    } else if (['win', 'spring'].includes(active)) {
      pose.left = .10 + .65 * envelope; pose.right = -.10 - .65 * envelope;
      pose.leftElbow = .54 * envelope; pose.rightElbow = -.54 * envelope;
      pose.bounce = Math.pow(Math.sin(progress * Math.PI * 3), 2) * 10 * envelope;
      pose.head = Math.sin(progress * Math.PI * 4) * .035 * envelope;
    } else if (active === 'lose') {
      pose.head = .045 * envelope; pose.nod = 4 * envelope;
      pose.left = .10 - .135 * envelope; pose.right = -.10 + .135 * envelope;
      pose.lean = -.014 * envelope;
    } else if (['tomato', 'egg'].includes(active)) {
      pose.left = .10 + .05 * envelope; pose.right = -.10 - .05 * envelope;
      pose.leftElbow = 1.12 * envelope; pose.rightElbow = -1.12 * envelope;
      pose.head = Math.sin(progress * Math.PI * 7) * .065 * envelope;
      pose.nod = 3 * envelope;
    } else if (active === 'tea') {
      pose.right = -.10 + (this.rig.handToChin[0] + .10) * envelope; pose.rightElbow = this.rig.handToChin[1] * envelope;
      pose.head = -.045 * envelope; pose.nod = 2 * pulse;
    } else if (active === 'flower') {
      pose.left = .10 + .08 * envelope; pose.right = -.10 - .08 * envelope;
      pose.leftElbow = 1.05 * envelope; pose.rightElbow = -1.05 * envelope;
      pose.head = Math.sin(progress * Math.PI * 2) * .04 * envelope;
    }
    this.left.shoulder.rotation = pose.left * amount;
    this.right.shoulder.rotation = pose.right * amount;
    this.left.elbow.rotation = pose.leftElbow * amount;
    this.right.elbow.rotation = pose.rightElbow * amount;
    this.torso.scale.y = 1 + breath * .0035 * amount;
    this.torso.rotation = pose.lean * amount;
    this.torso.y = -pose.bounce * amount;
    this.headJoint.rotation = pose.head * amount;
    this.headJoint.y = -225 * this.rig.neck[1] + pose.nod * amount;
    this.shadow.scale.set(1 - pose.bounce * .005 * amount, 1);
    this.shadow.alpha = 1 - pose.bounce * .015 * amount;
    this.root.y = this.baseline;
    // Two short blinks separated by a long open-eye interval. No giant skin
    // ellipses cover the cheek and the always-smiling elder retains his artwork.
    const blinkClock = ((seconds % 5.7) + 5.7) % 5.7;
    this.lids.visible = this.rig.eyes.length > 0 && !low && (blinkClock < .095 || (blinkClock > .19 && blinkClock < .245));
  }

  destroy() { this.root.destroy({children: true}); }
}
