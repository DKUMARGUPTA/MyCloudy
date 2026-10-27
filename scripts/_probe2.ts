import {
  findBuyer, findSeller, findTotals, findIssueDate, findInvoiceNumber,
  findCurrency, findVatId, parseMoneyCents, scanMoneyTokens, rightmostMoney,
  composeInvoiceFacts,
} from "../tools/create-electronic-invoice/extract";

const P = (label: string, actual: unknown, expected: unknown) =>
  console.log(actual === expected ? "OK " : "FAIL", label, "→", JSON.stringify(actual), actual === expected ? "" : `expected ${JSON.stringify(expected)}`);

// The "Total:" buyer trap
P("buyer trap 'Total:' line", findBuyer([["INVOICE", "From: Acme Ltd", "Total: 119,00"]]), null);
// Bare total fallback
P("bare total", findTotals([["Subtotal: 100,00", "Total: 1234.56"]]).grand, 123456);
P("bare total summe", findTotals([["Summe: 1.234,56 EUR"]]).grand, 123456);
P("bare total with euro sign", findTotals([["Total: 119,00 €"]]).grand, 11900);
P("subtotal not grand", findTotals([["Subtotal: 100,00"]]).grand, null);
// due != grand
P("due != grand", findTotals([["Grand Total: 119,00 €"], ["Amount due: 100,00 €"]]), { grand: 11900, taxBasis: null, due: 10000 });
// mm-dd-yyyy
P("mm-dd date", findIssueDate([["Invoice date: 01/15/2024"]]), "2024-01-15");
P("dd-mm date", findIssueDate([["Datum: 15.01.2024"]]), "2024-01-15");
P("iso date", findIssueDate([["Date: 2024-01-15"]]), "2024-01-15");
P("due-date skipped", findIssueDate([["Due date: 20.02.2024"], ["Date: 15.02.2024"]]), "2024-02-15");
P("2-digit year", findIssueDate([["Date: 15.01.24"]]), "2024-01-15");
// fallback parties
P("fallback seller", findSeller([["INVOICE", "Acme Handel GmbH", "Hauptstr. 1"]]), "Acme Handel GmbH");
P("fallback buyer", findBuyer([["INVOICE", "Acme Handel GmbH", "", "Müller & Co KG"]]), "Müller & Co KG");
P("seller next line", findSeller([["From:", "Beta GmbH"]]), "Beta GmbH");
P("buyer bill to", findBuyer([["Bill To:", "Gamma SA"]]), "Gamma SA");
// invoice number traps
P("inv no trap 'Bill To:'", findInvoiceNumber([["Bill To: Buyer AG"]]), null);
P("inv no trap 'Invoice Date:'", findInvoiceNumber([["Invoice Date: 15.01.2024"]]), null);
// currency
P("eur symbol", findCurrency([["Grand Total: 119,00 €"]]).code, "EUR");
P("inr symbol", findCurrency([["Total: ₹ 1000"]]).code, "INR");
P("usd symbol", findCurrency([["Amount due: $199.99"]]).code, "USD");
P("gbp symbol", findCurrency([["Total: £50.00"]]).code, "GBP");
P("code near totals", findCurrency([["Grand Total (USD): 119.00"]]).code, "USD");
P("assumed default", findCurrency([["nothing here"]]).assumed, true);
// vat
P("gstin", findVatId([["GSTIN: 27AAPFU0939F1ZV"]]), "27AAPFU0939F1ZV");
P("gstin unlabeled", findVatId([["27AAPFU0939F1ZV"]]), "27AAPFU0939F1ZV");
P("ust id", findVatId([["USt-IdNr.: ATU12345675"]]), "ATU12345675");
P("mwst", findVatId([["MwSt: CH123456789"]]), "CH123456789");
P("no vat word", findVatId([["INVOICE DE123456789"]]), null);
// money parsing
P("money 100.00", parseMoneyCents("100.00"), 10000);
P("money 1.234,56", parseMoneyCents("1.234,56"), 123456);
P("money 1,234.56", parseMoneyCents("1,234.56"), 123456);
P("money 119,00", parseMoneyCents("119,00"), 11900);
P("money 1.234 (group)", parseMoneyCents("1.234"), 123400);
P("money 119", parseMoneyCents("119"), 11900);
P("money 0.05", parseMoneyCents("0.05"), 5);
P("money 1\u00a0234,56", parseMoneyCents("1\u00a0234,56"), 123456);
P("money round 10.005", parseMoneyCents("10.005"), 1001);
P("money empty", parseMoneyCents(""), null);
P("money garbage", parseMoneyCents("abc"), null);
P("tokens date line", JSON.stringify(scanMoneyTokens("Balance due (as of 15/01/2024): 100,00")), JSON.stringify(["15", "01", "2024", "100,00"]));
P("rightmost date+amount", rightmostMoney("Balance due (as of 15/01/2024): 100,00"), 10000);
// full compose on a labelless invoice
const r = composeInvoiceFacts([[
  "INVOICE", "Acme Handel GmbH", "", "Müller & Co KG",
  "Invoice #: 2024-118", "Date: 03/14/2024",
  "Total: 1.234,56",
]]);
console.log("compose:", JSON.stringify(r, null, 1).slice(0, 600));
