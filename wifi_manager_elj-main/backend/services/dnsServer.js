import * as dns from "native-dns";
import { asusRouter } from "./asusRouter.js";

const DNS_PORT = Number(process.env.DNS_PORT || 5354);
const DNS_UPSTREAM = process.env.DNS_UPSTREAM || "8.8.8.8";

function normalizeName(name) {
  return String(name || "")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();
}

function forwardQuestion(question, response) {
  const request = dns.Request({
    question: dns.Question({
      name: question.name,
      type: question.type,
    }),
    server: { address: DNS_UPSTREAM, port: 53, type: "udp" },
    timeout: 2000,
  });

  request.on("message", (err, msg) => {
    if (err) {
      response.send();
      return;
    }
    response.answer = msg.answer || [];
    response.authority = msg.authority || [];
    response.additional = msg.additional || [];

    if (response.answer && response.answer.length > 0) {
      const domain = normalizeName(question.name);
      for (const ans of response.answer) {
        if (ans.type === 1 && ans.address) { // A record (IPv4 address)
          asusRouter.recordDnsResolution(ans.address, domain);
        }
      }
    }
  });

  request.on("end", () => response.send());
  request.on("timeout", () => response.send());
  request.on("error", () => response.send());
  request.send();
}

export function startDnsServer() {
  const server = dns.createServer();

  server.on("request", (request, response) => {
    const [question] = request.question;
    if (!question || !question.name) {
      response.send();
      return;
    }

    const domain = normalizeName(question.name);
    console.log("Client requested:", domain);

    const clientIp = request.address?.address;
    if (clientIp) {
      asusRouter.recordClientDnsQuery(clientIp, domain);
    }

    if (asusRouter.isBlockedDomain(domain)) {
      console.log("[DNS] Blocked domain:", domain);
      response.header.rcode = dns.consts.NAME_TO_RCODE.NOTFOUND;
      if (question.type === dns.consts.NAME_TO_QTYPE.A) {
        response.answer.push(
          dns.A({
            name: domain,
            address: "0.0.0.0",
            ttl: 600,
          }),
        );
      }
      response.send();
      return;
    }

    forwardQuestion(question, response);
  });

  server.on("error", (err, buff, req, res) => {
    console.error("[DNS] server error", err.stack || err);
    if (res) {
      res.send();
    }
  });

  server.serve(DNS_PORT);
  console.log(
    `[DNS] native-dns server listening on port ${DNS_PORT}, upstream ${DNS_UPSTREAM}`,
  );
}
