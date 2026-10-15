// Turns a Shopify order (webhook JSON) into the book maker's input and Lulu's shipping address.
const COVER_IDS = ["pink", "purple", "blue", "teal", "green", "yellow", "orange", "red"];

// Must match the order form labels and the book maker's interest ids.
const INTERESTS = [
  ["unicorns", "Unicorns & magic"], ["princess", "Princesses & castles"], ["mermaids", "Mermaids & ocean"],
  ["ballet", "Ballet & dance"], ["flowers", "Flowers & butterflies"], ["pets", "Puppies, kittens & bunnies"],
  ["treats", "Sweet treats"], ["rainbows", "Rainbows & sunshine"], ["dinos", "Dinosaurs"],
  ["trucks", "Trucks & things that go"], ["space", "Space & rockets"], ["sharks", "Sharks & sea creatures"],
  ["knights", "Knights & castles"], ["sports", "Sports"], ["wild", "Wild animals"], ["music", "Music"],
];

const clean = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

function bookLineItems(order, titleMatch) {
  const m = clean(titleMatch).toLowerCase();
  return (order.line_items || []).filter(li => clean(li.title || li.name).toLowerCase().includes(m));
}

// Answers can live on the cart ("Additional details") or on the line item. Line item wins.
function answers(order, lineItem) {
  const out = {};
  for (const a of order.note_attributes || []) out[clean(a.name)] = clean(a.value);
  for (const p of (lineItem && lineItem.properties) || []) if (clean(p.value)) out[clean(p.name)] = clean(p.value);
  return out;
}

function toBookInput(order, lineItem) {
  const a = answers(order, lineItem);
  const problems = [];
  const name = (a["Child's name"] || "").replace(/[^A-Za-z' -]/g, "").trim();
  if (!/[A-Za-z]/.test(name)) problems.push("Child's name is missing.");
  let cover = (a["Cover color"] || "").toLowerCase();
  if (!COVER_IDS.includes(cover)) { if (cover) problems.push(`Unknown cover color "${a["Cover color"]}", used purple.`); cover = "purple"; }
  const favText = (a["Favorites"] || "").toLowerCase();
  const selected = INTERESTS.filter(([, label]) => favText.includes(label.toLowerCase())).map(([id]) => id).slice(0, 3);
  if (!selected.length) { problems.push("No favorites chosen, used Unicorns, Flowers and Pets."); selected.push("unicorns", "flowers", "pets"); }
  return {
    input: {
      name: name.slice(0, 15),
      meaning: (a["Name meaning"] || "").slice(0, 60),
      from: (a["From"] || "").slice(0, 24),
      words: (a["Special words"] || "").slice(0, 200),
      selected,
      cover,
    },
    problems,
    fatal: !/[A-Za-z]/.test(name),
  };
}

function luluAddress(order, fallbackPhone) {
  const s = order.shipping_address || {};
  const phone = clean(s.phone || order.phone || (order.customer && order.customer.phone) || (order.billing_address && order.billing_address.phone) || fallbackPhone);
  const addr = {
    name: clean(s.name || [s.first_name, s.last_name].filter(Boolean).join(" ")),
    street1: clean(s.address1),
    street2: clean(s.address2) || undefined,
    city: clean(s.city),
    state_code: clean(s.province_code) || undefined,
    country_code: clean(s.country_code),
    postcode: clean(s.zip),
    phone_number: phone,
    email: clean(order.email || order.contact_email),
  };
  const missing = ["name", "street1", "city", "country_code", "postcode", "phone_number"].filter(k => !addr[k]);
  return { addr, missing };
}

module.exports = { bookLineItems, toBookInput, luluAddress, INTERESTS, COVER_IDS };
