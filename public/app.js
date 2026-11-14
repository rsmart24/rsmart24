
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
let lastOrderTrigger = null;
let activeCategory = "all";
let currentLanguage = "bn";
let chosenCartItems = null;
let cartCheckoutMode = false;

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

function extractImageUrl(value, depth = 0) {
  if (!value || depth > 4) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) { const found = extractImageUrl(item, depth + 1); if (found) return found; }
    return "";
  }
  if (typeof value === "object") {
    for (const key of ["url","src","imageUrl","image_url","secure_url","original","originalUrl","thumbnail","thumbnailUrl","thumbnail_url","path","image","file","data"]) {
      if (value[key]) { const found = extractImageUrl(value[key], depth + 1); if (found) return found; }
    }
  }
  return "";
}
function productImage(product) {
  const candidates = [product.images, product.imageUrls, product.image, product.imageUrl, product.image_url, product.thumbnailUrl, product.thumbnail_url, product.media];
  let src = "";
  for (const candidate of candidates) { src = extractImageUrl(candidate); if (src) break; }
  if (src && src.startsWith("//")) src = "https:" + src;
  return src
    ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(product.name)}" loading="lazy" onerror="this.onerror=null;this.replaceWith(Object.assign(document.createElement('span'),{className:'image-placeholder',textContent:'ছবি পাওয়া যায়নি'}))">`
    : `<span class="image-placeholder">ছবি পাওয়া যায়নি</span>`;
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

  count.textContent = currentLanguage === "bn" ? `${filteredProducts.length}টি পণ্য` : `${filteredProducts.length} products`;

  if (!filteredProducts.length) {
    grid.innerHTML = '<div class="loading">এই ক্যাটাগরিতে কোনো পণ্য পাওয়া যায়নি।</div>';
    return;
  }

  grid.innerHTML = filteredProducts.map(p => {
    const hasPrice = p.sellingPrice !== null && p.sellingPrice !== undefined;
    const outOfStock = p.inStock === false;

    return `
      <article class="product-card" data-product-card="${escapeHtml(p.id)}" tabindex="0" role="button" aria-label="${escapeHtml(p.name)} বিস্তারিত দেখুন">
        <div class="product-image">${productImage(p)}</div>
        <div class="product-info">
          <h3>${escapeHtml(p.name)}</h3>
          <div class="product-bottom">
            <span class="price">
              ${p.originalPrice !== null && p.originalPrice !== undefined && p.originalPrice > p.sellingPrice
                ? `<del class="old-price">${money(p.originalPrice)}</del>`
                : ""}
              <strong>${money(p.sellingPrice)}</strong>
            </span>
          </div>
          <div class="product-card-actions">
            <button class="buy-button" data-buy="${escapeHtml(p.id)}" ${outOfStock || !hasPrice ? "disabled" : ""}>
              ${outOfStock ? "স্টক নেই" : !hasPrice ? "দাম আসছে" : "অর্ডার নাও"}
            </button>
            <button class="card-cart-button" type="button" data-cart="${escapeHtml(p.id)}" ${outOfStock || !hasPrice ? "disabled" : ""}>🛒 কার্টে যোগ</button>
          </div>
        </div>
      </article>`;
  }).join("");

  grid.querySelectorAll("[data-product-card]").forEach(card => {
    const open = () => chooseProduct(card.dataset.productCard);
    card.addEventListener("click", event => {
      if (event.target.closest("button")) return;
      open();
    });
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
  grid.querySelectorAll("[data-buy]").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      chooseProduct(button.dataset.buy);
    });
  });
  grid.querySelectorAll("[data-cart]").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      const product = products.find(p => String(p.id) === String(button.dataset.cart));
      if (!product) return;
      if ((product.variants || []).some(v => v.color || v.size)) { chooseProduct(product.id); return; }
      addProductToCart(product);
      button.textContent = "✓ যোগ হয়েছে";
    });
  });
}

function closeOrderModal() {
  orderSection.hidden = true;
  document.body.classList.remove("order-modal-open");
  document.querySelector(".floating-shop")?.classList.remove("is-hidden");
  if (lastOrderTrigger?.isConnected) lastOrderTrigger.focus();
  lastOrderTrigger = null;
}

document.querySelector("#close-order")?.addEventListener("click", closeOrderModal);

orderSection.addEventListener("click", event => {
  if (event.target === orderSection) closeOrderModal();
});

document.addEventListener("keydown", event => {
  if (orderSection.hidden) return;

  if (event.key === "Escape") {
    event.preventDefault();
    closeOrderModal();
    return;
  }

  if (event.key !== "Tab") return;
  const focusable = [...orderSection.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter(element => element.getClientRects().length > 0);

  if (!focusable.length) {
    event.preventDefault();
    document.querySelector("#close-order")?.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

function readCart() {
  try { const value=JSON.parse(localStorage.getItem("rsMartCart")||"[]"); return Array.isArray(value)?value.filter(x=>x&&x.id!=null):[]; }
  catch (_) { return []; }
}
function saveCart(cart) { localStorage.setItem("rsMartCart",JSON.stringify(cart)); updateCartCount(); renderCartPage(); }
function updateCartCount() {
  const cart=readCart(), quantity=cart.reduce((sum,item)=>sum+Math.max(1,Number(item.quantity||1)),0);
  const link=document.querySelector(".header-cart"), floating=document.querySelector("#floating-cart-count");
  if(floating) floating.textContent=String(quantity);
  if(link) { let badge=link.querySelector(".cart-count"); if(!badge){badge=document.createElement("span");badge.className="cart-count";link.appendChild(badge);} badge.textContent=String(quantity);badge.hidden=quantity===0; }
}
function liveCartItems() {
  return readCart().map(item=>{
    const product=products.find(p=>String(p.id)===String(item.id));
    if(!product||product.inStock===false||product.sellingPrice==null)return null;
    return {...item,product,quantity:Math.max(1,Math.min(20,Number(item.quantity||1))),price:Number(product.sellingPrice)};
  }).filter(Boolean);
}
function addProductToCart(product,color="",size="") {
  if(!product)return;
  const cart=readCart();
  const existing=cart.find(x=>String(x.id)===String(product.id)&&String(x.color||"")===color&&String(x.size||"")===size);
  if(existing)existing.quantity=Math.min(20,Number(existing.quantity||1)+1);
  else cart.push({id:product.id,quantity:1,color,size});
  saveCart(cart);
  const button=document.querySelector("#detail-add-cart");
  if(button&&chosenProduct&&String(chosenProduct.id)===String(product.id)){button.textContent="✓ কার্টে যোগ হয়েছে";button.classList.add("is-added");}
}
function renderCartPage() {
  const box=document.querySelector("#cart-items"),empty=document.querySelector("#cart-empty"),summary=document.querySelector("#cart-summary");
  if(!box||!empty||!summary)return;
  const items=liveCartItems();
  if(!items.length){box.innerHTML="";empty.hidden=false;summary.hidden=true;return;}
  empty.hidden=true;summary.hidden=false;
  box.innerHTML=items.map(item=>'<article class="cart-item" data-cart-item="'+escapeHtml(item.id)+'" data-cart-color="'+escapeHtml(item.color||"")+'" data-cart-size="'+escapeHtml(item.size||"")+'"><div class="cart-item-image">'+productImage(item.product)+'</div><div class="cart-item-info"><h3>'+escapeHtml(item.product.name)+'</h3><div class="cart-item-variant">'+escapeHtml([item.color,item.size].filter(Boolean).join(" / ")||"ভ্যারিয়েন্ট প্রযোজ্য নয়")+'</div><strong>'+money(item.price)+'</strong><div class="cart-quantity"><button type="button" data-cart-decrease>−</button><span>'+item.quantity+'</span><button type="button" data-cart-increase>+</button><button type="button" class="cart-remove" data-cart-remove>সরান</button></div></div><b class="cart-line-total">'+money(item.price*item.quantity)+'</b></article>').join("");
  const subtotal=items.reduce((sum,item)=>sum+item.price*item.quantity,0);
  document.querySelector("#cart-subtotal").textContent=money(subtotal);
  document.querySelector("#cart-total").textContent=money(subtotal);
  document.querySelector("#cart-delivery").textContent="ঠিকানা নির্বাচন করুন";
}
function openCartPage() {
  closeOrderModal();
  document.querySelector("#products")?.setAttribute("hidden","");
  document.querySelector("#cart-page")?.removeAttribute("hidden");
  renderCartPage();
  document.querySelector("#cart-page")?.scrollIntoView({behavior:"smooth",block:"start"});
  history.replaceState(null,"","#cart");
}
function showProductsPage() {
  document.querySelector("#cart-page")?.setAttribute("hidden","");
  document.querySelector("#products")?.removeAttribute("hidden");
  document.querySelector("#products")?.scrollIntoView({behavior:"smooth",block:"start"});
  history.replaceState(null,"","#products");
}
function startCartCheckout() {
  const items=liveCartItems();
  if(!items.length){renderCartPage();return;}
  chosenCartItems=items.map(x=>({id:x.id,quantity:x.quantity,color:x.color||"",size:x.size||""}));
  cartCheckoutMode=true;chosenProduct=items[0].product;
  orderSection.classList.add("cart-checkout-mode");
  const summary=document.querySelector("#cart-checkout-summary");
  summary.hidden=false;
  summary.innerHTML="<h3>আপনার নির্বাচিত পণ্য ("+items.length+"টি)</h3>"+items.map(x=>"<div><span>"+escapeHtml(x.product.name)+" × "+x.quantity+"</span><b>"+money(x.price*x.quantity)+"</b></div>").join("");
  document.querySelector("#productId").value=chosenProduct.id;
  document.querySelector("#selected-product").textContent="একাধিক পণ্যের অর্ডার";
  document.querySelector("#order-quantity").closest("label").hidden=true;
  showProductsPage();
  orderSection.hidden=false;
  document.body.classList.add("order-modal-open");
  document.querySelector(".floating-shop")?.classList.add("is-hidden");
  document.querySelector("#cart-page")?.setAttribute("hidden","");
  updateOrderSummary();
  orderSection.scrollIntoView({behavior:"smooth",block:"start"});
}
document.querySelector("#cart-items")?.addEventListener("click",event=>{
  const row=event.target.closest("[data-cart-item]");if(!row)return;
  const id=row.dataset.cartItem,color=row.dataset.cartColor||"",size=row.dataset.cartSize||"",cart=readCart();
  const index=cart.findIndex(x=>String(x.id)===String(id)&&String(x.color||"")===color&&String(x.size||"")===size);
  if(index<0)return;
  if(event.target.closest("[data-cart-remove]"))cart.splice(index,1);
  else if(event.target.closest("[data-cart-increase]"))cart[index].quantity=Math.min(20,Number(cart[index].quantity||1)+1);
  else if(event.target.closest("[data-cart-decrease]"))cart[index].quantity=Math.max(1,Number(cart[index].quantity||1)-1);
  else return;
  saveCart(cart);
});
document.querySelector("#cart-continue-shopping")?.addEventListener("click",showProductsPage);
document.querySelector("#cart-empty-shop")?.addEventListener("click",showProductsPage);
document.querySelector("#cart-checkout")?.addEventListener("click",startCartCheckout);
document.querySelector("#floating-cart")?.addEventListener("click",openCartPage);

function openDetailOrderForm() {
  const wrap = document.querySelector("#detail-order-form-wrap");
  if (!wrap) return;
  wrap.hidden = false;
  wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  wrap.querySelector('input[name="customerName"]')?.focus({ preventScroll: true });
}
function updateOrderSummary() {
  if(!chosenProduct)return;
  const quantity=Math.max(1,Math.min(20,Number(document.querySelector("#order-quantity")?.value||1)));
  const division=document.querySelector("#customerDivision")?.value||"";
  const method=document.querySelector('input[name="paymentMethod"]:checked')?.value||"cod";
  const isDhaka=division==="ঢাকা"||division.toLowerCase()==="dhaka";
  const delivery=division?Number(isDhaka?deliveryCharges.insideDhaka||0:deliveryCharges.outsideDhaka||0):null;
  const lines=cartCheckoutMode&&chosenCartItems?.length?chosenCartItems.map(item=>{const p=products.find(x=>String(x.id)===String(item.id));return p?{subtotal:Number(p.sellingPrice||0)*item.quantity,percent:Number(p.discountPercent||0)}:null;}).filter(Boolean):[{subtotal:Number(chosenProduct.sellingPrice||0)*quantity,percent:Number(chosenProduct.discountPercent||0)}];
  const subtotal=lines.reduce((n,x)=>n+x.subtotal,0);
  const discount=method==="advance"?lines.reduce((n,x)=>n+Math.round(x.subtotal*x.percent/100),0):0;
  const total=delivery===null?null:subtotal+delivery-discount;
  const dText=delivery===null?"ঠিকানা নির্বাচন করুন":money(delivery),tText=total===null?"ঠিকানা নির্বাচন করুন":money(total);
  document.querySelector("#subtotal-value").textContent=money(subtotal);
  document.querySelector("#delivery-value").textContent=dText;
  document.querySelector("#discount-row").hidden=method!=="advance"||discount<=0;
  document.querySelector("#discount-value").textContent=money(discount);
  document.querySelector("#grand-total-value").textContent=tText;
  document.querySelector("#cod-subtotal").textContent=money(subtotal);
  document.querySelector("#cod-delivery").textContent=dText;
  document.querySelector("#cod-total").textContent=delivery===null?dText:money(subtotal+delivery);
  document.querySelector("#advance-subtotal").textContent=money(subtotal);
  document.querySelector("#advance-discount-amount").textContent=money(discount);
  document.querySelector("#advance-delivery").textContent=dText;
  document.querySelector("#advance-total").textContent=tText;
  const percent=cartCheckoutMode?Math.round(lines.reduce((n,x)=>n+x.subtotal*x.percent,0)/Math.max(1,subtotal)):Number(chosenProduct.discountPercent||0);
  const badge=document.querySelector("#advance-discount-badge");
  if(badge)badge.textContent=percent>0?(cartCheckoutMode?"পণ্যভেদে ছাড়":percent+"% ছাড়"):"ছাড় নেই";
  document.querySelector(".payment-option-cod")?.classList.toggle("is-selected",method==="cod");
  document.querySelector(".payment-option-advance")?.classList.toggle("is-selected",method==="advance");
  document.querySelector(".payment-option-advance")?.classList.toggle("has-discount",percent>0);
  document.querySelector("#bkash-payment-box").hidden=method!=="advance";
  document.querySelector("#transaction-id").required=method==="advance";
  document.querySelector("#advance-payment-amount").textContent=dText;
}
document.querySelector("#detail-order-now")?.addEventListener("click", openDetailOrderForm);
document.querySelector("#order-form")?.addEventListener("input", updateOrderSummary);
document.querySelector("#order-form")?.addEventListener("change", updateOrderSummary);
document.querySelector("#copy-bkash-number")?.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText("01716862470"); showNotice("বিকাশ নম্বর কপি হয়েছে।"); }
  catch (_) { showNotice("বিকাশ নম্বর: 01716862470"); }
});
document.querySelector("#transaction-id")?.addEventListener("input", event => {
  const value = event.target.value.trim().toUpperCase();
  event.target.value = value;
  const hint = document.querySelector("#transaction-id-hint");
  const valid = /^[A-Z0-9]{8,12}$/.test(value);
  if (hint) {
    hint.textContent = valid
      ? "✓ Transaction ID-এর ফরম্যাট সঠিক। আসল পেমেন্ট অ্যাডমিন যাচাই করবেন।"
      : "৮–১২ অক্ষরের আলফানিউমেরিক Transaction ID লিখুন।";
    hint.classList.toggle("is-valid", valid);
  }
});
document.querySelector("#close-order-success")?.addEventListener("click", () => {
  document.querySelector("#order-success").hidden = true;
});
document.querySelector("#detail-form-open")?.addEventListener("click", openDetailOrderForm);
document.querySelector("#detail-add-cart")?.addEventListener("click", () => {
  const color=document.querySelector("#selected-color")?.value||"", size=document.querySelector("#selected-size")?.value||"";
  if(document.querySelector("#selected-color")&&!color){alert("পণ্যের রং নির্বাচন করুন।");return;}
  if(document.querySelector("#selected-size")&&!size){alert("পণ্যের সাইজ নির্বাচন করুন।");return;}
  addProductToCart(chosenProduct,color,size);
});
document.querySelector("#detail-multi-order")?.addEventListener("click", () => {
  const color=document.querySelector("#selected-color")?.value||"", size=document.querySelector("#selected-size")?.value||"";
  if(document.querySelector("#selected-color")&&!color){alert("পণ্যের রং নির্বাচন করুন।");return;}
  if(document.querySelector("#selected-size")&&!size){alert("পণ্যের সাইজ নির্বাচন করুন।");return;}
  addProductToCart(chosenProduct,color,size); openCartPage();
});
document.querySelector(".header-cart")?.addEventListener("click", event => { event.preventDefault(); openCartPage(); });

function chooseProduct(id) {
  lastOrderTrigger = document.activeElement;
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

  cartCheckoutMode=false; chosenCartItems=null; orderSection.classList.remove("cart-checkout-mode");
  document.querySelector("#cart-checkout-summary").hidden=true;
  document.querySelector("#order-quantity").closest("label").hidden=false;
  document.querySelector("#productId").value = chosenProduct.id;
  document.querySelector("#detail-image").innerHTML = productImage(chosenProduct);
  document.querySelector("#selected-product").textContent = chosenProduct.name || "পণ্যের নাম";
  document.querySelector("#item-price").textContent = money(chosenProduct.sellingPrice);

  const oldPrice = document.querySelector("#item-old-price");
  const hasDiscount = Number(chosenProduct.originalPrice) > Number(chosenProduct.sellingPrice);
  oldPrice.hidden = !hasDiscount;
  oldPrice.textContent = hasDiscount ? money(chosenProduct.originalPrice) : "";
  document.querySelector("#detail-offer").hidden = !hasDiscount;

  const category = String(chosenProduct.category || "অন্যান্য").replace(/[-_]/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
  document.querySelector("#detail-category").textContent = "📁 " + category;
  document.querySelector("#detail-stock").textContent = "✓ In stock";

  document.querySelector("#detail-description").textContent =
    chosenProduct.description || "এই পণ্যের বিস্তারিত তথ্য পাওয়া যায়নি।";

  const variants = Array.isArray(chosenProduct.variants) ? chosenProduct.variants : [];
  const variantBox = document.querySelector("#detail-variants");
  const colors = [...new Set(variants.map(v => v.color).filter(Boolean))];
  const sizes = [...new Set(variants.map(v => v.size).filter(Boolean))];
  let variantHTML = "";

  if (colors.length) {
    variantHTML += `<label>রং নির্বাচন করুন<select id="selected-color" required><option value="">রং বেছে নিন</option>${colors.map(color => `<option value="${escapeHtml(color)}">${escapeHtml(color)}</option>`).join("")}</select></label>`;
  }
  if (sizes.length) {
    variantHTML += `<label>সাইজ নির্বাচন করুন<select id="selected-size" required><option value="">সাইজ বেছে নিন</option>${sizes.map(size => `<option value="${escapeHtml(size)}">${escapeHtml(size)}</option>`).join("")}</select></label>`;
  }
  variantBox.innerHTML = variantHTML;

  document.querySelector("#delivery-price").textContent =
    `ঢাকার ভিতরে ${money(deliveryCharges.insideDhaka)} / ঢাকার বাইরে ${money(deliveryCharges.outsideDhaka)}`;

  document.querySelector("#order-form")?.reset();
  document.querySelector("#order-quantity").value = "1";
  document.querySelector("#bkash-payment-box").hidden = true;
  document.querySelector("#transaction-id").required = false;
  updateOrderSummary();
  const cartButton = document.querySelector("#detail-add-cart");
  cartButton.textContent = "🛒 Add to Cart";
  cartButton.classList.remove("is-added");
  orderSection.hidden = false;
  document.body.classList.add("order-modal-open");
  document.querySelector(".floating-shop")?.classList.add("is-hidden");
  document.querySelector("#close-order")?.focus();
}
updateCartCount();
renderCartPage();

document.querySelectorAll(".category-nav [data-category], .footer-links [data-category]").forEach(button => {
  button.addEventListener("click", () => {
    activeCategory = button.dataset.category;

    document.querySelectorAll(".category-nav [data-category]").forEach(item => {
      item.classList.toggle("active", item.dataset.category === activeCategory);
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
    renderCartPage();
    updateCartCount();

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
  submitButton.textContent = currentLanguage === "bn" ? "অর্ডার পাঠানো হচ্ছে…" : "Submitting order…";

  const data = new FormData(form);

  const payload = {
    productId: chosenProduct.id,
    items: cartCheckoutMode && chosenCartItems?.length ? chosenCartItems : [{id:chosenProduct.id,quantity:Number(data.get("quantity")||1),color,size}],
    customerName: data.get("customerName"),
    customerPhone: data.get("customerPhone"),
    customerAddress: data.get("customerAddress"),
    customerDivision: data.get("customerDivision"),
    customerDistrict: data.get("customerDistrict"),
    customerArea: data.get("customerArea"),
    customerNote: data.get("customerNote"),
    color,
    size,
    quantity: Number(data.get("quantity") || 1),
    paymentMethod: data.get("paymentMethod") || "cod",
    transactionId: data.get("transactionId") || ""
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

    form.reset();
    if(cartCheckoutMode){localStorage.removeItem("rsMartCart");updateCartCount();renderCartPage();}
    cartCheckoutMode=false;chosenCartItems=null;orderSection.classList.remove("cart-checkout-mode");
    document.querySelector("#cart-checkout-summary").hidden=true;
    document.querySelector("#order-quantity").closest("label").hidden=false;
    closeOrderModal();
    chosenProduct = null;
    document.querySelector("#success-order-id").textContent = result.orderId;
    document.querySelector("#order-success").hidden = false;

  } catch (error) {
    alert(`অর্ডার জমা হয়নি: ${error.message}`);

  } finally {
    submitButton.disabled = false;
    submitButton.textContent = currentLanguage === "bn" ? "অর্ডার কনফার্ম করুন" : "Confirm order";
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
        option.textContent = item.en_name ? `${item.bn_name} (${item.en_name})` : item.bn_name;
        select.appendChild(option);
      });

      select.disabled = items.length === 0;
    }

    fillSelect(divisionSelect, "বিভাগ নির্বাচন করুন", divisions);

    fillSelect(districtSelect, "আগে বিভাগ নির্বাচন করুন", []);
    fillSelect(areaSelect, "আগে জেলা নির্বাচন করুন", []);

    divisionSelect.addEventListener("change", () => {
      updateOrderSummary();
      const division = divisions.find(
        item => item.bn_name === divisionSelect.value
      );

      const districts = division?.districts || [];

      fillSelect(districtSelect, "জেলা নির্বাচন করুন", districts);
      fillSelect(areaSelect, "আগে জেলা নির্বাচন করুন", []);
    });

    districtSelect.addEventListener("change", () => {
      updateOrderSummary();
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

/* ===== BANNER SLIDER ===== */
(() => {
  const slider = document.querySelector("#banner-slider");
  if (!slider) return;
  const slides = [...slider.querySelectorAll(".banner-slide")];
  const dots = [...slider.querySelectorAll(".banner-dots button")];
  const previous = document.querySelector("#banner-prev");
  const next = document.querySelector("#banner-next");
  if (!slides.length) return;
  let active = 0, timer = null, touchStartX = 0;
  function showSlide(index) {
    active = (index + slides.length) % slides.length;
    slides.forEach((slide, i) => slide.classList.toggle("active", i === active));
    dots.forEach((dot, i) => dot.classList.toggle("active", i === active));
  }
  function startAuto() {
    clearInterval(timer);
    timer = setInterval(() => showSlide(active + 1), 5000);
  }
  previous?.addEventListener("click", () => { showSlide(active - 1); startAuto(); });
  next?.addEventListener("click", () => { showSlide(active + 1); startAuto(); });
  dots.forEach((dot, i) => dot.addEventListener("click", () => { showSlide(i); startAuto(); }));
  slider.addEventListener("touchstart", e => { touchStartX = e.changedTouches[0].clientX; }, {passive:true});
  slider.addEventListener("touchend", e => {
    const delta = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(delta) > 45) showSlide(active + (delta < 0 ? 1 : -1));
    startAuto();
  }, {passive:true});
  slider.addEventListener("mouseenter", () => clearInterval(timer));
  slider.addEventListener("mouseleave", startAuto);
  showSlide(0);
  startAuto();
})();

/* ===== BENGALI / ENGLISH LANGUAGE SWITCH ===== */
const languageButton = document.querySelector("#language-toggle");
const languageLabel = document.querySelector("#language-label");
const translations = {
  bn: {
    tagline:"স্মার্ট মানুষের জন্য স্মার্ট ডিল", cart:"কার্ট", all:"সব পণ্য",
    gadgets:"স্মার্ট গ্যাজেট", decor:"হোম ডেকোরেশন", fashion:"ফ্যাশন",
    gaming:"গেমিং আইটেম", mobile:"মোবাইল অ্যাক্সেসরিজ", ourProducts:"আমাদের পণ্য",
    cod:"ক্যাশ অন ডেলিভারি", codDesc:"পণ্য হাতে পেয়ে মূল্য পরিশোধ করুন",
    fast:"দ্রুত ডেলিভারি", fastDesc:"দ্রুত ও নির্ভরযোগ্য ডেলিভারি",
    ship:"সারা দেশে ডেলিভারি", shipDesc:"সারা বাংলাদেশে পণ্য পৌঁছে দিচ্ছি",
    search:"পণ্য খুঁজুন..."
  },
  en: {
    tagline:"Smart Deals For Smart People", cart:"Cart", all:"All Products",
    gadgets:"Smart Gadgets", decor:"Home Decoration", fashion:"Fashion",
    gaming:"Gaming Items", mobile:"Mobile Accessories", ourProducts:"Our Products",
    cod:"Cash on Delivery", codDesc:"Pay when your product arrives",
    fast:"Fast Delivery", fastDesc:"Quick and reliable delivery",
    ship:"Nationwide Shipping", shipDesc:"Delivering across Bangladesh",
    search:"Search smart gadgets, fashion or more..."
  }
};
function setLanguage(language) {
  currentLanguage = language;
  document.documentElement.lang = language;
  document.querySelectorAll("[data-i18n]").forEach(element => {
    const key = element.dataset.i18n;
    if (translations[language][key]) element.textContent = translations[language][key];
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(element => {
    const key = element.dataset.i18nPlaceholder;
    if (translations[language][key]) element.placeholder = translations[language][key];
  });
  if (languageLabel) languageLabel.textContent = language === "bn" ? "বাংলা" : "English";
  if (products.length) renderProducts();
}
languageButton?.addEventListener("click", () => setLanguage(currentLanguage === "bn" ? "en" : "bn"));
setLanguage("bn");
document.querySelector("#search-button")?.addEventListener("click", () => searchInput?.focus());
