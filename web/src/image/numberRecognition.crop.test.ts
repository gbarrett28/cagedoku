import { describe, expect, it } from 'vitest';
import {
  centerByCentroid,
  extractRawDigitCrop,
  getWarpFromRect,
  prepareRecognitionCrop,
  warpRawDigitCrop,
} from './numberRecognition.js';
import type { OpenCVMat, OpenCVModule } from './opencv.js';

interface RectLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

class FakeMat {
  data: Uint8Array;
  readonly pointData: readonly number[] | undefined;
  readonly cloneData: ArrayLike<number> | undefined;

  constructor(
    readonly rows: number = 0,
    readonly cols: number = 0,
    data: ArrayLike<number> = [],
    pointData?: readonly number[],
    cloneData?: ArrayLike<number>,
  ) {
    this.data = Uint8Array.from(data);
    this.pointData = pointData;
    this.cloneData = cloneData;
  }

  roi(rect: RectLike): OpenCVMat {
    const pixels: number[] = [];
    for (let row = rect.y; row < rect.y + rect.height; row++) {
      const start = row * this.cols + rect.x;
      pixels.push(...this.data.slice(start, start + rect.width));
    }
    const dataOffset = rect.y * this.cols + rect.x;
    const stridedView = this.data.slice(dataOffset, dataOffset + rect.width * rect.height);
    return new FakeMat(rect.height, rect.width, stridedView, undefined, pixels) as unknown as OpenCVMat;
  }

  clone(): OpenCVMat {
    return new FakeMat(this.rows, this.cols, this.cloneData ?? this.data) as unknown as OpenCVMat;
  }

  delete(): void {}
}

interface FakeTransform {
  readonly src: readonly number[];
  readonly dst: readonly number[];
  delete(): void;
}

class FakeRect implements RectLike {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly width: number,
    readonly height: number,
  ) {}
}

class FakeSize {
  constructor(readonly width: number, readonly height: number) {}
}

function makeCv(): OpenCVModule {
  const cv = {
    CV_8UC1: 0,
    CV_32FC2: 1,
    INTER_LINEAR: 2,
    Mat: FakeMat,
    Rect: FakeRect,
    Size: FakeSize,
    matFromArray(rows: number, cols: number, type: number, data: readonly number[]) {
      return new FakeMat(rows, cols, type === 1 ? [] : data, type === 1 ? data : undefined);
    },
    getPerspectiveTransform(src: FakeMat, dst: FakeMat): FakeTransform {
      return { src: src.pointData ?? [], dst: dst.pointData ?? [], delete() {} };
    },
    warpPerspective(
      source: FakeMat,
      output: FakeMat,
      transform: FakeTransform,
      size: FakeSize,
    ): void {
      const xs = transform.src.filter((_, index) => index % 2 === 0);
      const ys = transform.src.filter((_, index) => index % 2 === 1);
      const left = Math.round(Math.min(...xs));
      const right = Math.round(Math.max(...xs));
      const top = Math.round(Math.min(...ys));
      const bottom = Math.round(Math.max(...ys));
      const selected: number[] = [];
      for (let row = top; row < bottom; row++) {
        const start = row * source.cols + left;
        selected.push(...source.data.slice(start, start + right - left));
      }
      output.data = Uint8Array.from([
        size.width,
        size.height,
        right - left,
        bottom - top,
        ...transform.dst.map(value => Math.round(value * 10)),
        ...selected,
      ]);
    },
  };
  return cv as unknown as OpenCVModule;
}

function grid(): OpenCVMat {
  return new FakeMat(4, 6, [
    0, 1, 2, 3, 4, 5,
    10, 11, 12, 13, 14, 15,
    20, 21, 22, 23, 24, 25,
    30, 31, 32, 33, 34, 35,
  ]) as unknown as OpenCVMat;
}

describe('raw digit crops', () => {
  it('copies the exact non-square bounding-box pixels from the warped grid', () => {
    const crop = extractRawDigitCrop(makeCv(), grid(), [2, 1, 3, 2]);

    expect(crop).toEqual({
      x: 2,
      y: 1,
      width: 3,
      height: 2,
      pixels: new Uint8Array([12, 13, 14, 22, 23, 24]),
    });
  });

  it.each([
    [[0, 0, 0, 2], 'positive'],
    [[0, 0, 2, 0], 'positive'],
    [[-1, 0, 2, 2], 'bounds'],
    [[0, -1, 2, 2], 'bounds'],
    [[4, 0, 3, 2], 'bounds'],
    [[0, 3, 2, 2], 'bounds'],
  ] as const)('rejects invalid rectangle %j', (rect, message) => {
    expect(() => extractRawDigitCrop(makeCv(), grid(), rect)).toThrow(message);
  });
});

describe('raw digit crop warping', () => {
  it('matches the existing stretch geometry', () => {
    const cv = makeCv();
    const warpedGrid = grid();
    const rect = [2, 1, 3, 2] as const;
    const source = [[2, 1], [5, 1], [5, 3], [2, 3]];
    const expected = getWarpFromRect(cv, source, warpedGrid, 8, 8);
    const crop = extractRawDigitCrop(cv, warpedGrid, rect);

    expect(warpRawDigitCrop(cv, crop, 'stretch', 8)).toEqual(expected);
  });

  it('matches the existing letterbox geometry', () => {
    const cv = makeCv();
    const warpedGrid = grid();
    const rect = [2, 1, 3, 2] as const;
    const scale = 7 / 3;
    const destHeight = 2 * scale;
    const offsetY = (7 - destHeight) / 2;
    const source = [[2, 1], [5, 1], [5, 3], [2, 3]];
    const destination = [[0, offsetY], [7, offsetY], [7, offsetY + destHeight], [0, offsetY + destHeight]];
    const expected = getWarpFromRect(cv, source, warpedGrid, 8, 8, destination);
    const crop = extractRawDigitCrop(cv, warpedGrid, rect);

    expect(warpRawDigitCrop(cv, crop, 'letterbox', 8)).toEqual(expected);
  });

  it('applies centerByCentroid on top of the letterbox result for letterbox-centered', () => {
    const cv = makeCv();
    const warpedGrid = grid();
    const rect = [2, 1, 3, 2] as const;
    const scale = 7 / 3;
    const destHeight = 2 * scale;
    const offsetY = (7 - destHeight) / 2;
    const source = [[2, 1], [5, 1], [5, 3], [2, 3]];
    const destination = [[0, offsetY], [7, offsetY], [7, offsetY + destHeight], [0, offsetY + destHeight]];
    const letterboxResult = getWarpFromRect(cv, source, warpedGrid, 8, 8, destination);
    const expected = centerByCentroid(letterboxResult, 8);
    const crop = extractRawDigitCrop(cv, warpedGrid, rect);

    expect(warpRawDigitCrop(cv, crop, 'letterbox-centered', 8)).toEqual(expected);
  });
});


describe('greyscale recognition preprocessing', () => {
  const crop = {
    x: 0, y: 0, width: 3, height: 3,
    pixels: Uint8Array.from([
      240, 230, 240,
      230, 20, 230,
      240, 230, 240,
    ]),
  };

  it.each([
    'gray-inverted-contrast',
    'gray-adaptive',
    'gray-normalized',
  ] as const)('prepares deterministic %s crops', inputMode => {
    const first = prepareRecognitionCrop(makeCv(), crop, 'letterbox-centered', inputMode, 8);
    const second = prepareRecognitionCrop(makeCv(), crop, 'letterbox-centered', inputMode, 8);
    expect(first).toHaveLength(64);
    expect(first).toEqual(second);
    expect(first.some(value => value > 0)).toBe(true);
  });

  it('keeps binary preprocessing byte-for-byte compatible', () => {
    expect(prepareRecognitionCrop(makeCv(), crop, 'letterbox', 'binary', 8))
      .toEqual(warpRawDigitCrop(makeCv(), crop, 'letterbox', 8));
  });
});
