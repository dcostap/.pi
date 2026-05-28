const ADJECTIVES = [
  "Amber", "Apple", "Autumn", "Berry", "Blossom", "Blue", "Bright", "Breezy", "Calm", "Candy",
  "Cedar", "Cherry", "Cinder", "Clear", "Cloud", "Clover", "Cobalt", "Comet", "Copper", "Cozy",
  "Crimson", "Crystal", "Dainty", "Daisy", "Dawn", "Dewy", "Drift", "Dusky", "Echo", "Elm",
  "Ember", "Fable", "Feather", "Fern", "Fluffy", "Forest", "Frost", "Garden", "Gentle", "Golden",
  "Granite", "Harbor", "Hazel", "Honey", "Hollow", "Indigo", "Ivory", "Jade", "Jolly", "Juniper",
  "Kind", "Lavender", "Lemon", "Lily", "Lively", "Lucky", "Maple", "Meadow", "Mellow", "Midnight",
  "Misty", "Moonlit", "Mossy", "Nectar", "Nova", "Onyx", "Opal", "Peach", "Pebble", "Petal",
  "Pine", "Pink", "Plum", "Poppy", "Quiet", "Rainy", "Rapid", "River", "Rosy", "Ruby",
  "Sandy", "Sapphire", "Shady", "Shimmer", "Silver", "Skylit", "Slate", "Sleepy", "Soft", "Solar",
  "Sparkle", "Spruce", "Starry", "Stone", "Stormy", "Sugar", "Sunny", "Swift", "Tiny", "Velvet",
  "Violet", "Warm", "Whisper", "Willow", "Windy", "Winter", "Wistful", "Yonder", "Zephyr", "Zesty",
];

const NOUNS = [
  "Acorn", "Aspen", "Badger", "Beacon", "Bear", "Bee", "Berry", "Bird", "Bloom", "Brook",
  "Bunny", "Butterfly", "Canyon", "Cedar", "Cloud", "Comet", "Cove", "Cricket", "Cub", "Daisy",
  "Dawn", "Dove", "Dragonfly", "Falcon", "Fern", "Field", "Finch", "Firefly", "Flower", "Forest",
  "Fox", "Frog", "Garden", "Glade", "Glen", "Grove", "Harbor", "Harrier", "Haven", "Heron",
  "Hill", "Honeybee", "Iris", "Kestrel", "Kitten", "Lake", "Leaf", "Lily", "Lynx", "Maple",
  "Marble", "Meadow", "Moon", "Moth", "Nest", "Otter", "Owl", "Panda", "Pebble", "Petal",
  "Pine", "Pond", "Puffin", "Quartz", "Rabbit", "Raven", "Ridge", "Robin", "Rose", "Sage",
  "Shore", "Skylark", "Snowdrop", "Sparrow", "Sprout", "Squirrel", "Star", "Stone", "Stream", "Sunbeam",
  "Tiger", "Trail", "Tulip", "Vale", "Wave", "Willow", "Wolf", "Wren", "Yarrow", "Zephyr",
  "Blossom", "Clover", "Fawn", "Glow", "Lantern", "Moss", "Noodle", "Poppy", "Ripple", "Thistle",
];

function randomItem(items: string[]): string {
  return items[Math.floor(Math.random() * items.length)]!;
}

export function generateAgentName(excludedNames: Iterable<string>): string {
  const excluded = new Set(Array.from(excludedNames, (name) => name.toLowerCase()));

  for (let i = 0; i < 400; i++) {
    const candidate = `${randomItem(ADJECTIVES)}${randomItem(NOUNS)}`;
    if (!excluded.has(candidate.toLowerCase())) return candidate;
  }

  return `Agent${Math.floor(Math.random() * 9000) + 1000}`;
}
