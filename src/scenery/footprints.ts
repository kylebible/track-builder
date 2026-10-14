// Plan footprints of the scenery models, for standing them on support
// blocks when they're raised: [x min, x max, y min, y max] in mm, in the
// piece's own frame (track along x, y to its left), before any turning
// over. Measured from the models in models.ts and trackside.ts; a test
// checks they still match.

export type Footprint = [number, number, number, number];

export const MODEL_FOOTPRINTS: Record<string, Footprint> = {
  'tunnel': [-76, 76, -65, 65],
  'station': [-108, 108, 20, 73],
  'level-crossing': [26, 118, -90, 90],
  'bridge-pier': [-20, 20, -32, 32],
  'signal': [-13, 13, -13, 13],
  'leafy-tree': [-32, 32, -32, 32],
  'pine-tree': [-30, 30, -30, 30],
  'cottage': [-45, 45, -35, 35],
  'engine-shed': [-113, 113, -44, 44],
  'crane': [-34, 34, -34, 34],
  'cargo-loader': [-54, 54, -54, 54],
  'lift-bridge': [7, 197, -41, 59],
  'water-tower': [-45, 45, -4, 90],
  'coaling-stage': [-48, 48, 1, 82],
  'charging-post': [-22, 22, 23, 56],
  'coal-mine': [-95, 95, 5, 116],
  'power-station': [-100, 100, 26, 138],
  'farm': [-112, 110, 26, 146],
  'market': [-90, 90, 26, 110],
  'post-office': [-65, 65, 26, 116],
  'lumber-camp': [-111, 106, 24, 144],
  'sawmill': [-90, 90, 26, 120],
  'toy-factory': [-85, 85, 26, 130],
  'goods-shed': [-95, 95, 26, 110],
  'whistle-board': [-8, 8, 18, 42],
  'slow-board': [-8, 8, 17, 43],
};
