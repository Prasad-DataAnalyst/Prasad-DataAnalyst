// An ordinary JavaScript module, used from Tamas in bridge_js.tms.
class Counter {
  constructor(start) {
    this.count = start;
  }
  add(n) {
    this.count += n;
    return this;
  }
}

module.exports = {
  circleArea: (r) => Math.PI * r * r,
  describe: (shape) => `${shape.name} with ${shape.sides.length} sides: ${shape.sides.join(" x ")}`,
  later: async (value) => value * 2,
  Counter,
};
