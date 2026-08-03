const cartItems = [
  { name: "Auriculares Studio", detail: "Grafito · Envío hoy", price: "$249" },
  { name: "Cable USB-C trenzado", detail: "2 metros", price: "$24" }
];

export default function CheckoutPage() {
  return (
    <main>
      <header className="siteHeader">
        <a className="brand" href="#">Northstar</a>
        <nav aria-label="Principal"><a href="#checkout">Checkout</a><a href="#help">Ayuda</a></nav>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">DEMO INTERACTIVA</p>
          <h1>Prueba el ciclo completo<br />de feedback a código.</h1>
          <p>Activa Feedback, selecciona el botón de pago y describe que el texto está cortado. El estado del Issue y PR aparecerá en esta página.</p>
        </div>
        <ol className="instructions" data-feedback-ignore>
          <li><span>1</span>Pulsa “Feedback”</li>
          <li><span>2</span>Selecciona el botón azul</li>
          <li><span>3</span>Envía el comentario sugerido</li>
        </ol>
      </section>

      <section className="checkoutGrid" id="checkout">
        <div className="checkoutCard">
          <div className="sectionHeading"><div><p className="eyebrow">PAGO SEGURO</p><h2>Completa tu compra</h2></div><span className="secureBadge">SSL</span></div>
          <form>
            <label>Correo electrónico<input type="email" defaultValue="qa@example.com" data-feedback-redact /></label>
            <label>Nombre en la tarjeta<input defaultValue="Ada Lovelace" data-feedback-redact /></label>
            <label>Número de tarjeta<input inputMode="numeric" defaultValue="4242 4242 4242 4242" data-sensitive /></label>
            <div className="fieldRow"><label>Vencimiento<input defaultValue="12/30" data-sensitive /></label><label>CVC<input defaultValue="123" data-sensitive /></label></div>
            <button className="checkoutSubmit" type="button" data-feedback-id="checkout-submit" data-testid="checkout-submit">Continuar al pago seguro</button>
            <p className="bugHint">Este botón contiene el bug visual intencional del escenario.</p>
          </form>
        </div>

        <aside className="orderCard">
          <p className="eyebrow">TU PEDIDO</p>
          <h2>Resumen</h2>
          <div className="items">{cartItems.map((item) => <div className="item" key={item.name}><div className="productArt" aria-hidden>{item.name.slice(0, 1)}</div><div><strong>{item.name}</strong><small>{item.detail}</small></div><b>{item.price}</b></div>)}</div>
          <dl><div><dt>Subtotal</dt><dd>$273</dd></div><div><dt>Envío</dt><dd>Gratis</dd></div><div className="total"><dt>Total</dt><dd>$273</dd></div></dl>
        </aside>
      </section>
    </main>
  );
}
