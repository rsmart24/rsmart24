const grid = document.querySelector("#products-grid");
const notice = document.querySelector("#notice");
const count = document.querySelector("#product-count");
const orderSection = document.querySelector("#order");
const form = document.querySelector("#order-form");
const searchInput = document.querySelector("#product-search");
let products = [];
let deliveryCharges = {};
let chosenProduct = null;

document.querySelector("#year").textContent = new Date().getFullYear();

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `৳${n.toLocaleString("en-BD")}` : "দাম জানতে যোগাযোগ করুন";
}
function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
}
function productImage(product) {
  const src = Array.isArray(product.images) ? product.images[0] : "";
  return src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(product.name)}" loading="lazy">` : `<span class="image-placeholder">RS</span>`;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function renderProducts() {
  const query = (searchInput?.value || "").trim().toLowerCase();

  const filteredProducts = products.filter(p =>
    `${p.name || ""} ${p.description || ""}`.toLowerCase().includes(query)
  );

  count.textContent = `${filteredProducts.length}টি পণ্য`;

  if (!filteredProducts.length) {
    grid.innerHTML = '<div class="loading">কোনো পণ্য পাওয়া যায়নি। অন্য নামে খুঁজে দেখুন।</div>';
    return;
  }

  grid.innerHTML = filteredProducts.map(p => `
    <article class="product-card">
      <div class="product-image">${productImage(p)}</div>
      <div class="product-info">
        <h3>${escapeHtml(p.name)}</h3>
        <p>${escapeHtml(p.description || "বিস্তারিত জানতে অর্ডার করুন।")}</p>
        <div class="product-bottom">
          <span class="price">${money(p.suggestedPrice)}</span>
          <button class="buy-button" data-buy="${escapeHtml(p.id)}" ${p.inStock === false ? "disabled" : ""}>
            ${p.inStock === false ? "স্টক নেই" : "অর্ডার করুন"}
          </button>
        </div>
      </div>
    </article>`).join("");

  grid.querySelectorAll("[data-buy]").forEach(button =>
    button.addEventListener("click", () => chooseProduct(button.dataset.buy))
  );
}
function chooseProduct(id) {
  chosenProduct = products.find(p => String(p.id) === String(id));
  if (!chosenProduct) return;
  document.querySelector("#productId").value = chosenProduct.id;
  document.querySelector("#selected-product").textContent = `${chosenProduct.name} — ${money(chosenProduct.suggestedPrice)}`;
  document.querySelector("#item-price").textContent = money(chosenProduct.suggestedPrice);
  document.querySelector("#delivery-price").textContent = `ঢাকার ভিতরে ${money(deliveryCharges.insideDhaka)} / ঢাকার বাইরে ${money(deliveryCharges.outsideDhaka)}`;
  orderSection.hidden = false;
  orderSection.scrollIntoView({ behavior: "smooth" });
}
async function loadProducts() {
  try {
    const response = await fetch("/api/products");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "পণ্য লোড করা যায়নি।");
    products = data.data || [];
    deliveryCharges = data.deliveryCharges || {};
    renderProducts();
  } catch (error) {
    count.textContent = "লোড করা যায়নি";
    grid.innerHTML = '<div class="loading">পণ্য দেখানো যাচ্ছে না। Cloudflare-এ Business Koro API key সেট করা আছে কি না যাচাই করুন।</div>';
    showNotice(error.message);
  }
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!chosenProduct) return;
  submitButton.disabled = true;
  submitButton.textContent = "অর্ডার পাঠানো হচ্ছে…";
  const data = new FormData(form);
  const payload = {
    productId: chosenProduct.id,
    customerName: data.get("customerName"),
    customerPhone: data.get("customerPhone"),
    customerAddress: data.get("customerAddress"),
    customerDivision: data.get("customerDivision"),
    customerDistrict: data.get("customerDistrict"),
    customerArea: data.get("customerArea"),
    sellingPrice: Number(chosenProduct.suggestedPrice),
    customerNote: data.get("customerNote")
  };
  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || result.error || "অর্ডার জমা হয়নি।");
    alert(result.duplicate ? "এই ধরনের অর্ডার আগে জমা হয়েছে। Business Koro-তে অর্ডারটি যাচাই করুন।" : "আপনার অর্ডার পাঠানো হয়েছে। ধন্যবাদ!");
    form.reset();
    orderSection.hidden = true;
    chosenProduct = null;
  } catch (error) {
    alert(`অর্ডার জমা হয়নি: ${error.message}`);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "অর্ডার কনফার্ম করুন";
  }
});
loadProducts();
