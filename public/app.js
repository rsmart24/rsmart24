
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
let multiOrderItems = [];
let orderOriginView = "products";

document.querySelector("#year").textContent = new Date().getFullYear();

function isOutOfStock(item) {
  if (!item || typeof item !== "object") return false;
  const normalize = value => String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const status = normalize(item.stockStatus ?? item.stock_status ?? item.availability ?? item.status);
  const stock = item.inStock ?? item.in_stock ?? item.available;
  const stockText = normalize(stock);
  return stock === false || stock === 0 || stock === "0" || stockText === "false" ||
    ["out_of_stock", "sold_out", "outofstock", "unavailable"].includes(status) ||
    ["out_of_stock", "sold_out", "outofstock", "unavailable"].includes(stockText);
}

function money(value) {
  if (value === null || value === undefined || value === "") {
    return "দাম নির্ধারণ করা হয়নি";
  }
  const n = Number(value);
  return Number.isFinite(n) ? `৳${n.toLocaleString("en-BD")}` : "দাম পাওয়া যায়নি";
}

function advanceDiscountPrice(product) {
  const price = Number(product?.sellingPrice);
  const percent = Number(product?.discountPercent || 0);
  if (!Number.isFinite(price)) return null;
  return percent > 0 ? Math.max(0, Math.round(price * (100 - percent) / 100)) : price;
}

function advanceDiscountNote(product) {
  const percent = Number(product?.discountPercent || 0);
  const codPrice = Number(product?.sellingPrice);
  if (!(percent > 0) || !Number.isFinite(codPrice)) return "";
  return `<p class="product-payment-discount-note">অগ্রিম ডেলিভারি চার্জ দিলে পণ্যের দামে ${percent}% ছাড় প্রযোজ্য। ক্যাশ অন ডেলিভারিতে দাম ${money(codPrice)}।</p>`;
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

function renderFeaturedSections() {
  const trending = products.filter(p => p.isVisible !== false && !isOutOfStock(p) && p.isTrending);
  const section = document.querySelector("#trending-section");
  const strip = document.querySelector("#trending-products");
  if (!section || !strip) return;
  section.hidden = !trending.length;
  strip.innerHTML = trending.map(p => `<article class="featured-product-card" data-featured-product="${escapeHtml(p.id)}" tabindex="0" role="button" aria-label="${escapeHtml(p.name)} বিস্তারিত দেখুন"><div class="featured-product-image">${productImage(p)}<span class="featured-trending-badge">TRENDING</span></div><div class="featured-product-info"><h3>${escapeHtml(p.name || "পণ্য")}</h3><div class="featured-product-price"><strong>${money(advanceDiscountPrice(p))}</strong></div></div></article>`).join("");
  strip.querySelectorAll("[data-featured-product]").forEach(card => {
    const open = () => chooseProduct(card.dataset.featuredProduct);
    card.addEventListener("click", open);
    card.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  });
}

async function loadDhamaakaHomeSection() {
  const section=document.querySelector("#dhamaaka-home-section");
  const banner=document.querySelector("#dhamaaka-banner-wrap");
  const strip=document.querySelector("#dhamaaka-home-product");
  if(!section||!strip)return;
  try {
    const response=await fetch("/api/dhamaaka-offer",{cache:"no-store"});
    const result=await response.json();
    if(!response.ok||!result.active||!result.product){section.hidden=true;if(banner)banner.hidden=true;return;}
    const p=result.product;
    const image=(p.images||[])[0]||"";
    const price=Number(p.sellingPrice||0);
    const advance=Number(p.discountPercent||0)>0?Math.round(price*(100-Number(p.discountPercent))/100):price;
    const offerPercent=Number(result.discountPercent||30);
    section.hidden=false;
    if(banner)banner.hidden=false;
    const note=document.querySelector("#dhamaaka-home-note");
    if(note)note.textContent="BUY 2 GET "+offerPercent+"% OFF";
    strip.innerHTML=`<a class="featured-product-card dhamaaka-featured-card" href="/dhamaaka-offer.html">
      <div class="featured-product-image">${image?`<img src="${escapeHtml(image)}" alt="${escapeHtml(p.name)}" loading="lazy">`:"<span>RS Mart</span>"}<span class="featured-trending-badge dhamaaka-badge">২টি কিনলে ${offerPercent}% ছাড়</span></div>
      <div class="featured-product-info"><h3>${escapeHtml(p.name||"ধামাকা অফার")}</h3><div class="dhamaaka-savings-callout"><span>একসাথে ২টি কিনলে</span><strong>${offerPercent}% ছাড়!</strong><small>একসাথে কিনুন, বেশি সাশ্রয় করুন</small></div><div class="featured-product-price"><strong>${money(advance)}</strong></div>${advanceDiscountNote(p)}<span class="dhamaaka-card-cta">সম্পূর্ণ অফার দেখতে ক্লিক করুন →</span></div>
    </a>`;
  } catch(error) { section.hidden=true;if(banner)banner.hidden=true; }
}

function renderProducts() {
  renderFeaturedSections();
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
    const outOfStock = isOutOfStock(p);

    return `
      <article class="product-card ${outOfStock ? "is-out-of-stock" : ""}" data-product-card="${escapeHtml(p.id)}" tabindex="0" role="button" aria-label="${escapeHtml(p.name)} বিস্তারিত দেখুন">
        <div class="product-image">${productImage(p)}${Number(p.discountPercent) > 0 ? `<span class="product-advance-discount-badge">অগ্রিমে ${Number(p.discountPercent)}% ছাড়</span>` : ""}${outOfStock ? '<span class="stock-out-overlay">স্টক আউট</span>' : ""}</div>
        <div class="product-info">
          <h3>${escapeHtml(p.name)}</h3>
          <div class="product-bottom">
            <span class="price">
              ${Number(p.discountPercent) > 0
                ? `<del class="old-price">${money(p.sellingPrice)}</del>`
                : (p.originalPrice !== null && p.originalPrice !== undefined && p.originalPrice > p.sellingPrice ? `<del class="old-price">${money(p.originalPrice)}</del>` : "")}
              <strong>${money(advanceDiscountPrice(p))}</strong>
            </span>
          </div>
          ${advanceDiscountNote(p)}
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
      addProductToCart(product);
      button.textContent = "✓ যোগ হয়েছে";
    });
  });
}

function closeOrderModal(syncHistory = false) {
  if (syncHistory && /^#product-/.test(location.hash)) history.back();
  orderSection.hidden = true;
  document.body.classList.remove("order-modal-open");
  document.querySelector(".floating-shop")?.classList.remove("is-hidden");
  if (lastOrderTrigger?.isConnected) lastOrderTrigger.focus();
  lastOrderTrigger = null;
}

document.querySelector("#close-order")?.addEventListener("click", () => closeOrderModal(true));

orderSection.addEventListener("click", event => {
  if (event.target === orderSection) closeOrderModal(true);
});

document.addEventListener("keydown", event => {
  if (orderSection.hidden) return;

  if (event.key === "Escape") {
    event.preventDefault();
    closeOrderModal(true);
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
    if(!product||isOutOfStock(product)||product.sellingPrice==null)return null;
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
function cartVariantSelect(item, type, values) {
  if (!values.length) return "";
  const selected=String(item[type]||"");
  const label=type==="color"?"রং":"সাইজ";
  return '<label class="cart-variant-field">'+label+'<select data-cart-variant="'+type+'"><option value="">'+label+' নির্বাচন করুন</option>'+values.map(v=>'<option value="'+escapeHtml(v)+'" '+(selected===String(v)?"selected":"")+'>'+escapeHtml(v)+'</option>').join("")+'</select></label>';
}
function renderCartPage() {
  const box=document.querySelector("#cart-items"),empty=document.querySelector("#cart-empty"),summary=document.querySelector("#cart-summary");
  if(!box||!empty||!summary)return;
  const raw=readCart(),items=liveCartItems();
  if(!items.length){box.innerHTML="";empty.hidden=false;summary.hidden=true;return;}
  empty.hidden=true;summary.hidden=false;
  box.innerHTML=items.map(item=>{
    const variants=Array.isArray(item.product.variants)?item.product.variants:[];
    const colors=[...new Set(variants.map(v=>v.color).filter(Boolean))];
    const sizes=[...new Set(variants.map(v=>v.size).filter(Boolean))];
    return '<article class="cart-item" data-cart-item="'+escapeHtml(item.id)+'" data-cart-color="'+escapeHtml(item.color||"")+'" data-cart-size="'+escapeHtml(item.size||"")+'"><div class="cart-item-image">'+productImage(item.product)+'</div><div class="cart-item-info"><h3>'+escapeHtml(item.product.name)+'</h3><div class="cart-variant-edit">'+cartVariantSelect(item,"color",colors)+cartVariantSelect(item,"size",sizes)+'</div><strong>'+money(item.price)+'</strong><div class="cart-quantity"><button type="button" data-cart-decrease aria-label="পরিমাণ কমান">−</button><span>'+item.quantity+'</span><button type="button" data-cart-increase aria-label="পরিমাণ বাড়ান">+</button><button type="button" class="cart-remove" data-cart-remove>সরান</button></div></div><b class="cart-line-total">'+money(item.price*item.quantity)+'</b></article>';
  }).join("");
  const subtotal=items.reduce((sum,item)=>sum+item.price*item.quantity,0);
  document.querySelector("#cart-subtotal").textContent=money(subtotal);
  document.querySelector("#cart-total").textContent=money(subtotal);
  document.querySelector("#cart-delivery").textContent="ঠিকানা নির্বাচন করুন";
}
function openCartPage(pushHistory = true) {
  closeOrderModal();
  document.querySelector("#products")?.setAttribute("hidden","");
  document.querySelector("#cart-page")?.removeAttribute("hidden");
  renderCartPage();
  document.querySelector("#cart-page")?.scrollIntoView({behavior:"smooth",block:"start"});
  if(pushHistory) history.pushState({view:"cart"},"","#cart");
}
function showProductsPage(pushHistory = true) {
  document.querySelector("#cart-page")?.setAttribute("hidden","");
  document.querySelector("#products")?.removeAttribute("hidden");
  document.querySelector("#products")?.scrollIntoView({behavior:"smooth",block:"start"});
  if(pushHistory) history.pushState({view:"products"},"","#products");
}
function startCartCheckout() {
  const items=liveCartItems();
  if(!items.length){renderCartPage();return;}
  chosenCartItems=items.map(x=>({id:x.id,quantity:x.quantity,color:x.color||"",size:x.size||""}));
  cartCheckoutMode=true;chosenProduct=items[0].product;
  orderSection.classList.add("cart-checkout-mode");
  const summary=document.querySelector("#cart-checkout-summary");
  summary.hidden=false;
  summary.innerHTML="<h3>আপনার নির্বাচিত পণ্য ("+items.length+"টি)</h3>"+items.map((x,i)=>{const vars=Array.isArray(x.product.variants)?x.product.variants:[];const colors=[...new Set(vars.map(v=>v.color).filter(Boolean))];const sizes=[...new Set(vars.map(v=>v.size).filter(Boolean))];const field=(type,values,label)=>values.length?'<label class="cart-variant-field">'+label+'<select required data-checkout-variant="'+type+'" data-checkout-index="'+i+'"><option value="">'+label+' নির্বাচন করুন</option>'+values.map(v=>'<option value="'+escapeHtml(v)+'" '+(String(x[type]||"")===String(v)?"selected":"")+'>'+escapeHtml(v)+'</option>').join("")+'</select></label>':"";return "<div class=\"checkout-cart-line\"><span>"+escapeHtml(x.product.name)+" × "+x.quantity+"<span class=\"checkout-cart-variants\">"+field("color",colors,"রং")+field("size",sizes,"সাইজ")+"</span></span><b>"+money(x.price*x.quantity)+"</b></div>";}).join("");
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
document.querySelector("#cart-checkout-summary")?.addEventListener("change",event=>{
  const select=event.target.closest("[data-checkout-variant]");if(!select||!chosenCartItems)return;
  const index=Number(select.dataset.checkoutIndex),type=select.dataset.checkoutVariant;
  if(!Number.isInteger(index)||!chosenCartItems[index])return;
  chosenCartItems[index][type]=select.value;
});
document.querySelector("#cart-items")?.addEventListener("change",event=>{
  const select=event.target.closest("[data-cart-variant]");if(!select)return;
  const row=select.closest("[data-cart-item]");if(!row)return;
  const cart=readCart(),oldColor=row.dataset.cartColor||"",oldSize=row.dataset.cartSize||"";
  const index=cart.findIndex(x=>String(x.id)===String(row.dataset.cartItem)&&String(x.color||"")===oldColor&&String(x.size||"")===oldSize);
  if(index<0)return;
  const type=select.dataset.cartVariant;
  cart[index][type]=select.value;
  const duplicate=cart.findIndex((x,i)=>i!==index&&String(x.id)===String(cart[index].id)&&String(x.color||"")===String(cart[index].color||"")&&String(x.size||"")===String(cart[index].size||""));
  if(duplicate>=0){cart[duplicate].quantity=Math.min(20,Number(cart[duplicate].quantity||1)+Number(cart[index].quantity||1));cart.splice(index,1);}
  saveCart(cart);
});
document.querySelector("#cart-continue-shopping")?.addEventListener("click",showProductsPage);
document.querySelector("#cart-empty-shop")?.addEventListener("click",showProductsPage);
document.querySelector("#cart-checkout")?.addEventListener("click",startCartCheckout);
document.querySelector("#floating-cart")?.addEventListener("click",openCartPage);
window.addEventListener("popstate", () => {
  if (location.hash === "#cart") { closeOrderModal(); openCartPage(false); return; }
  const productMatch=location.hash.match(/^#product-(.+)$/);
  if (productMatch) {
    const id=decodeURIComponent(productMatch[1]);
    if (multiOrderItems.length && String(multiOrderItems[multiOrderItems.length-1].id)===String(id)) multiOrderItems.pop();
    document.querySelector("#cart-page")?.setAttribute("hidden","");
    document.querySelector("#products")?.removeAttribute("hidden");
    chooseProduct(id,false);
    return;
  }
  closeOrderModal();
  document.querySelector("#cart-page")?.setAttribute("hidden","");
  document.querySelector("#products")?.removeAttribute("hidden");
});

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
  const method=document.querySelector('input[name="paymentMethod"]:checked')?.value||"advance";
  const isDhaka=division==="ঢাকা"||division.toLowerCase()==="dhaka";
  const delivery=division?Number(isDhaka?deliveryCharges.insideDhaka||0:deliveryCharges.outsideDhaka||0):null;
  const lines=cartCheckoutMode&&chosenCartItems?.length?chosenCartItems.map(item=>{const p=products.find(x=>String(x.id)===String(item.id));if(!p)return null;const unitPrice=Number(p.sellingPrice||0);const percent=Number(p.discountPercent||0);const discountedUnitPrice=method==="advance"&&percent>0?Math.max(0,Math.round(unitPrice*(100-percent)/100)):unitPrice;return {subtotal:unitPrice*item.quantity,quantity:item.quantity,percent,discountedUnitPrice,discountAmount:(unitPrice-discountedUnitPrice)*item.quantity};}).filter(Boolean):(()=>{const unitPrice=Number(chosenProduct.sellingPrice||0);const percent=Number(chosenProduct.discountPercent||0);const discountedUnitPrice=method==="advance"&&percent>0?Math.max(0,Math.round(unitPrice*(100-percent)/100)):unitPrice;return [{subtotal:unitPrice*quantity,quantity,percent,discountedUnitPrice,discountAmount:(unitPrice-discountedUnitPrice)*quantity}];})();
  const subtotal=lines.reduce((n,x)=>n+x.subtotal,0);
  const discount=method==="advance"?lines.reduce((n,x)=>n+x.discountAmount,0):0;
  const total=subtotal+(delivery===null?0:delivery)-discount;
  const dText=delivery===null?"ঠিকানা নির্বাচন করুন":money(delivery),tText=money(total);
  document.querySelector("#subtotal-value").textContent=money(subtotal);
  document.querySelector("#delivery-value").textContent=dText;
  document.querySelector("#discount-row").hidden=method!=="advance"||discount<=0;
  document.querySelector("#discount-value").textContent=money(discount);
  document.querySelector("#grand-total-value").textContent=tText;
  const grandTotalLabel=document.querySelector("#grand-total-label");
  if(grandTotalLabel)grandTotalLabel.textContent=delivery===null?(method==="advance"?"ছাড়ের পর পণ্যের দাম (ডেলিভারি ছাড়া)":"পণ্যের মোট দাম (ডেলিভারি ছাড়া)"):"সর্বমোট (ডেলিভারি চার্জসহ)";
   const advanceTotalLabel=document.querySelector("#advance-total-label");
   if(advanceTotalLabel)advanceTotalLabel.textContent=delivery===null?"ছাড়ের পর পণ্যের দাম (ডেলিভারি ছাড়া)":"ছাড়ের পর সর্বমোট (ডেলিভারি চার্জসহ)";
  document.querySelector("#cod-subtotal").textContent=money(subtotal);
  document.querySelector("#cod-delivery").textContent=dText;
  document.querySelector("#cod-total").textContent=money(subtotal+(delivery===null?0:delivery));
  document.querySelector("#advance-subtotal").textContent=money(subtotal);
  document.querySelector("#advance-discount-amount").textContent=money(discount);
  document.querySelector("#advance-delivery").textContent=dText;
  document.querySelector("#advance-total").textContent=tText;
  // Keep the product detail price synchronized with the selected payment method.
  if (!cartCheckoutMode && chosenProduct) {
    const productPrice = Number(chosenProduct.sellingPrice || 0);
    const advancePercent = Number(chosenProduct.discountPercent || 0);
    const advancePrice = advanceDiscountPrice(chosenProduct);
    const showAdvance = method === "advance" && advancePercent > 0;
    const displayPrice = method === "advance" ? advancePrice : productPrice;
    const crossedPrice = advancePercent > 0 ? (showAdvance ? productPrice : advancePrice) : chosenProduct.originalPrice;
    document.querySelector("#item-price").textContent = money(displayPrice);
    const oldPrice = document.querySelector("#item-old-price");
    const hasCrossedPrice = Number(crossedPrice) > Number(displayPrice);
    oldPrice.hidden = !hasCrossedPrice;
    oldPrice.textContent = hasCrossedPrice ? money(crossedPrice) : "";
    const paymentDiscountNote = document.querySelector("#detail-payment-discount-note");
    if (paymentDiscountNote) {
      paymentDiscountNote.hidden = advancePercent <= 0;
      paymentDiscountNote.textContent = advancePercent > 0
        ? (showAdvance
          ? `অগ্রিম ডেলিভারি চার্জ দিলে পণ্যের দামে ${advancePercent}% ছাড় প্রযোজ্য। ক্যাশ অন ডেলিভারিতে দাম ${money(productPrice)}।`
          : `এই ${advancePercent}% ছাড় শুধু অগ্রিম ডেলিভারি চার্জ দিলে প্রযোজ্য। অগ্রিম দিলে দাম ${money(advancePrice)}।`)
        : "";
    }
  }
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
const customerPhoneInput = document.querySelector("#customer-phone");
customerPhoneInput?.addEventListener("input", event => {
  const input = event.target;
  input.value = input.value
    .replace(/[০-৯]/g, digit => "০১২৩৪৫৬৭৮৯".indexOf(digit))
    .replace(/[^0-9+]/g, "");
  const value = input.value;
  const valid = /^(?:01[3-9][0-9]{8}|\+8801[3-9][0-9]{8}|8801[3-9][0-9]{8})$/.test(value);
  input.setCustomValidity(value && !valid ? "সঠিক বাংলাদেশি মোবাইল নম্বর লিখুন (যেমন 017XXXXXXXX)।" : "");
  const icon = document.querySelector("#phone-valid-icon");
  const hint = document.querySelector("#phone-validation-hint");
  if (icon) icon.hidden = !valid;
  if (hint) {
    hint.textContent = valid ? "✓ মোবাইল নম্বর সঠিক।" : "১১ সংখ্যার বাংলাদেশি মোবাইল নম্বর লিখুন।";
    hint.classList.toggle("is-valid", valid);
  }
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
  if (!chosenProduct) return;
  const color=document.querySelector("#selected-color")?.value||"", size=document.querySelector("#selected-size")?.value||"";
  addProductToCart(chosenProduct,color,size);
});
document.querySelector("#detail-multi-order")?.addEventListener("click", () => {
  if (!chosenProduct) return;
  if (cartCheckoutMode && chosenCartItems?.length) {
    // Preserve every cart item; do not replace the first item with the last one.
    multiOrderItems = chosenCartItems.map(item => ({...item}));
  } else {
    const color=document.querySelector("#selected-color")?.value||"";
    const size=document.querySelector("#selected-size")?.value||"";
    const quantity=Math.max(1,Math.min(20,Number(document.querySelector("#order-quantity")?.value||1)));
    const existing=multiOrderItems.find(x=>String(x.id)===String(chosenProduct.id)&&x.color===color&&x.size===size);
    if(existing) existing.quantity=Math.min(20,existing.quantity+quantity);
    else multiOrderItems.push({id:chosenProduct.id,quantity,color,size});
  }
  cartCheckoutMode=false;
  chosenCartItems=null;
  orderSection.classList.remove("cart-checkout-mode");
  document.querySelector("#cart-checkout-summary").hidden=true;
  document.querySelector("#order-quantity").closest("label").hidden=false;
  closeOrderModal();
  showProductsPage();
  showNotice("আগের পণ্যগুলো অর্ডারের তালিকায় রাখা হয়েছে। আরও পণ্য বেছে নিন।");
});
document.querySelector(".header-cart")?.addEventListener("click", event => { event.preventDefault(); openCartPage(); });

function chooseProduct(id, pushHistory = true) {
  lastOrderTrigger = document.activeElement;
  chosenProduct = products.find(p => String(p.id) === String(id));
  if (!chosenProduct) return;

  if (chosenProduct.sellingPrice === null || chosenProduct.sellingPrice === undefined) {
    alert("এই পণ্যের বিক্রয়মূল্য এখনো নির্ধারণ করা হয়নি।");
    return;
  }

  if (isOutOfStock(chosenProduct)) {
    alert("দুঃখিত, পণ্যটি স্টকে নেই।");
    return;
  }

  cartCheckoutMode=multiOrderItems.length>0;
  chosenCartItems=cartCheckoutMode?[...multiOrderItems.map(x=>({...x})),{id:chosenProduct.id,quantity:1,color:"",size:""}]:null;
  orderSection.classList.toggle("cart-checkout-mode",cartCheckoutMode);
  document.querySelector("#cart-checkout-summary").hidden=!cartCheckoutMode;
  document.querySelector("#order-quantity").closest("label").hidden=cartCheckoutMode;
  document.querySelector("#productId").value = chosenProduct.id;
  const detailImage = document.querySelector("#detail-image");
  detailImage.innerHTML = productImage(chosenProduct);
  const detailImg = detailImage.querySelector("img");
  const cardImg = document.querySelector('[data-product-card="' + CSS.escape(String(chosenProduct.id)) + '"] .product-image img');
  if (detailImg && cardImg) {
    detailImg.addEventListener("error", () => {
      if (cardImg.src && detailImg.src !== cardImg.src) detailImg.src = cardImg.src;
      else detailImage.innerHTML = '<span class="image-placeholder">ছবি পাওয়া যায়নি</span>';
    }, { once: true });
  }
  document.querySelector("#selected-product").textContent = chosenProduct.name || "পণ্যের নাম";
  const advancePercent = Number(chosenProduct.discountPercent || 0);
  const hasAdvanceDiscount = advancePercent > 0;
  document.querySelector("#item-price").textContent = money(advanceDiscountPrice(chosenProduct));

  const oldPrice = document.querySelector("#item-old-price");
  const oldValue = hasAdvanceDiscount ? chosenProduct.sellingPrice : chosenProduct.originalPrice;
  const hasDiscount = Number(oldValue) > Number(advanceDiscountPrice(chosenProduct));
  oldPrice.hidden = !hasDiscount;
  oldPrice.textContent = hasDiscount ? money(oldValue) : "";
  const paymentDiscountNote = document.querySelector("#detail-payment-discount-note");
  if (paymentDiscountNote) {
    paymentDiscountNote.hidden = !hasAdvanceDiscount;
    paymentDiscountNote.textContent = hasAdvanceDiscount ? `অগ্রিম ডেলিভারি চার্জ দিলে পণ্যের দামে ${advancePercent}% ছাড় প্রযোজ্য। ক্যাশ অন ডেলিভারিতে দাম ${money(chosenProduct.sellingPrice)}।` : "";
  }

  const category = String(chosenProduct.category || "অন্যান্য").replace(/[-_]/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
  document.querySelector("#detail-category").textContent = "📁 " + category;
  document.querySelector("#detail-stock").textContent = "✓ In stock";

  document.querySelector("#detail-description").textContent =
    chosenProduct.description || "এই পণ্যের বিস্তারিত তথ্য পাওয়া যায়নি।";
  const mediaButton = document.querySelector("#detail-media-button");
  const showMediaButton = chosenProduct.mediaEnabled !== false && Boolean(chosenProduct.mediaUrl);
  if (mediaButton) {
    mediaButton.hidden = !showMediaButton;
    if (showMediaButton) mediaButton.href = chosenProduct.mediaUrl;
    else mediaButton.removeAttribute("href");
    const title = document.querySelector("#selected-product");
    if (title && title.parentElement === mediaButton.parentElement) title.insertAdjacentElement("afterend", mediaButton);
  }

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
  variantBox.innerHTML = variantHTML || '<p class="no-variants-note">এই পণ্যে কালার বা সাইজ নির্বাচন করার প্রয়োজন নেই।</p>';
  if (cartCheckoutMode) {
    const summary=document.querySelector("#cart-checkout-summary");
    summary.innerHTML="<h3>আপনার নির্বাচিত পণ্য ("+chosenCartItems.length+"টি)</h3>"+chosenCartItems.map((x,i)=>{const p=products.find(v=>String(v.id)===String(x.id));const vars=Array.isArray(p?.variants)?p.variants:[];const colors=[...new Set(vars.map(v=>v.color).filter(Boolean))];const sizes=[...new Set(vars.map(v=>v.size).filter(Boolean))];const field=(type,values,label)=>values.length?'<label class="cart-variant-field">'+label+'<select required data-checkout-variant="'+type+'" data-checkout-index="'+i+'"><option value="">'+label+' নির্বাচন করুন</option>'+values.map(v=>'<option value="'+escapeHtml(v)+'" '+(String(x[type]||"")===String(v)?"selected":"")+'>'+escapeHtml(v)+'</option>').join("")+'</select></label>':"";return '<div class="checkout-cart-line"><span>'+escapeHtml(p?.name||"পণ্য")+' × '+x.quantity+'<span class="checkout-cart-variants">'+field("color",colors,"রং")+field("size",sizes,"সাইজ")+(i===chosenCartItems.length-1?'<small>সর্বশেষ নির্বাচিত পণ্য</small>':"")+'</span></span><b>'+money(Number(p?.sellingPrice||0)*x.quantity)+'</b></div>';}).join("");
    document.querySelector("#selected-product").textContent="একাধিক পণ্যের অর্ডার";
  }

  document.querySelector("#delivery-price").textContent =
    `ঢাকার ভিতরে ${money(deliveryCharges.insideDhaka)} / ঢাকার বাইরে ${money(deliveryCharges.outsideDhaka)}`;

  document.querySelector("#order-form")?.reset();
  document.querySelector("#payment-advance").checked = true;
  document.querySelector("#order-quantity").value = "1";
  if (cartCheckoutMode) { document.querySelector("#order-quantity").closest("label").hidden=true; document.querySelector("#selected-product").textContent="একাধিক পণ্যের অর্ডার"; }
  document.querySelector("#bkash-payment-box").hidden = true;
  document.querySelector("#transaction-id").required = false;
  updateOrderSummary();
  const cartButton = document.querySelector("#detail-add-cart");
  cartButton.textContent = "🛒 Add to Cart";
  cartButton.classList.remove("is-added");
  orderSection.hidden = false;
  if(pushHistory) history.pushState({view:"product",productId:chosenProduct.id},"","#product-"+encodeURIComponent(chosenProduct.id));
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

  if (!form.reportValidity()) return;
  if (!chosenProduct) return;

  if (chosenProduct.sellingPrice === null || chosenProduct.sellingPrice === undefined) {
    alert("এই পণ্যের বিক্রয়মূল্য নির্ধারণ করা হয়নি।");
    return;
  }

  const color = document.querySelector("#selected-color")?.value || "";
  const size = document.querySelector("#selected-size")?.value || "";

  if (!cartCheckoutMode) {
    if (document.querySelector("#selected-color") && !color) {
      alert("পণ্যের রং নির্বাচন করুন।");
      return;
    }
    if (document.querySelector("#selected-size") && !size) {
      alert("পণ্যের সাইজ নির্বাচন করুন।");
      return;
    }
  } else {
    for (const item of (chosenCartItems||[])) {
      const p=products.find(x=>String(x.id)===String(item.id));
      const vars=Array.isArray(p?.variants)?p.variants:[];
      if(vars.some(v=>v.color)&&!item.color){alert(p.name+" পণ্যের রং নির্বাচন করুন।");return;}
      if(vars.some(v=>v.size)&&!item.size){alert(p.name+" পণ্যের সাইজ নির্বাচন করুন।");return;}
    }
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
  const submissionFingerprint = JSON.stringify(payload);
  if (!window.rsMartPendingSubmissionKey || window.rsMartPendingSubmissionFingerprint !== submissionFingerprint) {
    window.rsMartPendingSubmissionKey = crypto.randomUUID();
    window.rsMartPendingSubmissionFingerprint = submissionFingerprint;
  }
  payload.submissionKey = window.rsMartPendingSubmissionKey;

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

    window.rsMartPendingSubmissionKey = null;
    window.rsMartPendingSubmissionFingerprint = null;
    form.reset();
    if(cartCheckoutMode){localStorage.removeItem("rsMartCart");updateCartCount();renderCartPage();}
    cartCheckoutMode=false;chosenCartItems=null;multiOrderItems=[];orderOriginView="products";orderSection.classList.remove("cart-checkout-mode");
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
    // Keep the built-in division options and allow manual district/upazila entry
    // so a third-party location-data outage cannot block checkout.
    districtSelect.outerHTML = '<input name="customerDistrict" id="customerDistrict" required maxlength="100" placeholder="জেলার নাম লিখুন">';
    areaSelect.outerHTML = '<input name="customerArea" id="customerArea" required maxlength="150" placeholder="থানা / উপজেলার নাম লিখুন">';
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
    slides.forEach((slide, i) => {
      slide.classList.toggle("active", i === active);
      if (i === active) {
        const image = slide.querySelector("img[data-src]");
        if (image) {
          image.src = image.dataset.src;
          image.removeAttribute("data-src");
        }
      }
    });
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



// Load the separately managed single-product Dhamaaka offer.
document.addEventListener("DOMContentLoaded", loadDhamaakaHomeSection);
