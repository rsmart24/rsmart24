
const grid = document.querySelector("#products-grid");
const notice = document.querySelector("#notice");
const count = document.querySelector("#product-count");
const orderSection = document.querySelector("#order");
const form = document.querySelector("#order-form");
const searchInput = document.querySelector("#product-search");
const submitButton = document.querySelector("#submit-button");

let products = [];
let deliveryCharges = {};
let chosenProduct = null;
let activeCategory = "all";

document.querySelector("#year").textContent = new Date().getFullYear();

function money(value) {
  if (value === null || value === undefined || value === "") {
    return "দাম নির্ধারণ করা হয়নি";
  }
  const n = Number(value);
  return Number.isFinite(n) ? `৳${n.toLocaleString("en-BD")}` : "দাম পাওয়া যায়নি";
}

function showNotice(message) {
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = false;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

function productImage(product) {
  const src = Array.isArray(product.images) ? product.images[0] : "";
  return src
    ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(product.name)}" loading="lazy">`
    : `<span class="image-placeholder">RS</span>`;
}

function renderProducts() {
  const query = (searchInput?.value || "").trim().toLowerCase();

  const filteredProducts = products.filter(p => {
    const matchesSearch =
      `${p.name || ""} ${p.description || ""}`.toLowerCase().includes(query);

    const matchesCategory =
      activeCategory === "all" || p.category === activeCategory;

    return matchesSearch && matchesCategory;
  });

  count.textContent = `${filteredProducts.length}টি পণ্য`;

  if (!filteredProducts.length) {
    grid.innerHTML = '<div class="loading">এই ক্যাটাগরিতে কোনো পণ্য পাওয়া যায়নি।</div>';
    return;
  }

  grid.innerHTML = filteredProducts.map(p => {
    const hasPrice = p.sellingPrice !== null && p.sellingPrice !== undefined;
    const outOfStock = p.inStock === false;

    return `
      <article class="product-card">
        <div class="product-image">${productImage(p)}</div>
        <div class="product-info">
          <h3>${escapeHtml(p.name)}</h3>
          <p>${escapeHtml(p.description || "বিস্তারিত জানতে পণ্যটি দেখুন।")}</p>
          <div class="product-bottom">
            <span class="price">${money(p.sellingPrice)}</span>
            <button class="buy-button"
              data-buy="${escapeHtml(p.id)}"
              ${outOfStock || !hasPrice ? "disabled" : ""}>
              ${outOfStock ? "স্টক নেই" : !hasPrice ? "দাম আসছে" : "অর্ডার করুন"}
            </button>
          </div>
        </div>
      </article>`;
  }).join("");

  grid.querySelectorAll("[data-buy]").forEach(button => {
    button.addEventListener("click", () => chooseProduct(button.dataset.buy));
  });
}

function chooseProduct(id) {
  chosenProduct = products.find(p => String(p.id) === String(id));
  if (!chosenProduct) return;

  if (chosenProduct.sellingPrice === null || chosenProduct.sellingPrice === undefined) {
    alert("এই পণ্যের বিক্রয়মূল্য এখনো নির্ধারণ করা হয়নি।");
    return;
  }

  if (chosenProduct.inStock === false) {
    alert("দুঃখিত, পণ্যটি স্টকে নেই।");
    return;
  }

  document.querySelector("#productId").value = chosenProduct.id;
  document.querySelector("#detail-image").innerHTML = productImage(chosenProduct);
  document.querySelector("#selected-product").textContent = chosenProduct.name || "পণ্যের নাম";
  document.querySelector("#item-price").textContent = money(chosenProduct.sellingPrice);

  document.querySelector("#detail-stock").textContent =
    chosenProduct.inStock === false ? "স্টক নেই" : "স্টকে আছে";

  document.querySelector("#detail-description").textContent =
    chosenProduct.description || "এই পণ্যের বিস্তারিত তথ্য পাওয়া যায়নি।";

  const variants = Array.isArray(chosenProduct.variants)
    ? chosenProduct.variants
    : [];

  const variantBox = document.querySelector("#detail-variants");
  const colors = [...new Set(variants.map(v => v.color).filter(Boolean))];
  const sizes = [...new Set(variants.map(v => v.size).filter(Boolean))];

  let variantHTML = "";

  if (colors.length) {
    variantHTML += `
      <label>রং নির্বাচন করুন
        <select id="selected-color" required>
          <option value="">রং বেছে নিন</option>
          ${colors.map(color => `
            <option value="${escapeHtml(color)}">${escapeHtml(color)}</option>
          `).join("")}
        </select>
      </label>`;
  }

  if (sizes.length) {
    variantHTML += `
      <label>সাইজ নির্বাচন করুন
        <select id="selected-size" required>
          <option value="">সাইজ বেছে নিন</option>
          ${sizes.map(size => `
            <option value="${escapeHtml(size)}">${escapeHtml(size)}</option>
          `).join("")}
        </select>
      </label>`;
  }

  variantBox.innerHTML = variantHTML;

  document.querySelector("#delivery-price").textContent =
    `ঢাকার ভিতরে ${money(deliveryCharges.insideDhaka)} / ঢাকার বাইরে ${money(deliveryCharges.outsideDhaka)}`;

  orderSection.hidden = false;
  orderSection.scrollIntoView({ behavior: "smooth" });
}

document.querySelectorAll(".category-nav [data-category]").forEach(button => {
  button.addEventListener("click", () => {
    activeCategory = button.dataset.category;

    document.querySelectorAll(".category-nav [data-category]").forEach(item => {
      item.classList.toggle("active", item === button);
    });

    renderProducts();
  });
});

async function loadProducts() {
  try {
    const response = await fetch("/api/products");
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "পণ্য লোড করা যায়নি।");
    }

    products = data.data || [];
    deliveryCharges = data.deliveryCharges || {};
    renderProducts();

  } catch (error) {
    count.textContent = "লোড করা যায়নি";
    grid.innerHTML = '<div class="loading">পণ্য দেখানো যাচ্ছে না। পরে আবার চেষ্টা করুন।</div>';
    showNotice(error.message);
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();

  if (!chosenProduct) return;

  if (chosenProduct.sellingPrice === null || chosenProduct.sellingPrice === undefined) {
    alert("এই পণ্যের বিক্রয়মূল্য নির্ধারণ করা হয়নি।");
    return;
  }

  const color = document.querySelector("#selected-color")?.value || "";
  const size = document.querySelector("#selected-size")?.value || "";

  if (document.querySelector("#selected-color") && !color) {
    alert("পণ্যের রং নির্বাচন করুন।");
    return;
  }

  if (document.querySelector("#selected-size") && !size) {
    alert("পণ্যের সাইজ নির্বাচন করুন।");
    return;
  }

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
    customerNote: data.get("customerNote"),
    color,
    size,
    quantity: Number(data.get("quantity") || 1)
  };

  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || result.message || "অর্ডার জমা হয়নি।");
    }

    alert(`আপনার অর্ডার RS Mart-এ জমা হয়েছে। অর্ডার নম্বর: ${result.orderId}`);

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

searchInput?.addEventListener("input", renderProducts);

loadProducts();

async function setupAddressDropdowns() {
  const divisionSelect = document.querySelector("#customerDivision");
  const districtSelect = document.querySelector("#customerDistrict");
  const areaSelect = document.querySelector("#customerArea");

  if (!divisionSelect || !districtSelect || !areaSelect) return;

  try {
    const response = await fetch(
      "https://iqbalhasandev.github.io/bangladesh-geo-json/bangladesh-geo.json"
    );

    if (!response.ok) throw new Error("Location data unavailable");

    const divisions = await response.json();

    function fillSelect(select, placeholder, items) {
      select.innerHTML = "";
      const first = document.createElement("option");
      first.value = "";
      first.textContent = placeholder;
      select.appendChild(first);

      items.forEach(item => {
        const option = document.createElement("option");
        option.value = item.bn_name;
        option.textContent = item.bn_name;
        select.appendChild(option);
      });

      select.disabled = items.length === 0;
    }

    fillSelect(divisionSelect, "বিভাগ নির্বাচন করুন", divisions);

    fillSelect(districtSelect, "আগে বিভাগ নির্বাচন করুন", []);
    fillSelect(areaSelect, "আগে জেলা নির্বাচন করুন", []);

    divisionSelect.addEventListener("change", () => {
      const division = divisions.find(
        item => item.bn_name === divisionSelect.value
      );

      const districts = division?.districts || [];

      fillSelect(districtSelect, "জেলা নির্বাচন করুন", districts);
      fillSelect(areaSelect, "আগে জেলা নির্বাচন করুন", []);
    });

    districtSelect.addEventListener("change", () => {
      const division = divisions.find(
        item => item.bn_name === divisionSelect.value
      );

      const district = division?.districts.find(
        item => item.bn_name === districtSelect.value
      );

      const upazilas = district?.upazilas || [];

      fillSelect(areaSelect, "থানা / উপজেলা নির্বাচন করুন", upazilas);
    });

  } catch (error) {
    console.error("Address dropdown error:", error);
    divisionSelect.innerHTML =
      '<option value="">ঠিকানার তালিকা লোড হয়নি</option>';
    districtSelect.disabled = true;
    areaSelect.disabled = true;
  }
}

setupAddressDropdowns();
