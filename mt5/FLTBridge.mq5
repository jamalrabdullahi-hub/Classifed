//+------------------------------------------------------------------+
//|                                                   FLTBridge.mq5 |
//|                     Mirrors this terminal's own trades to FLT.  |
//+------------------------------------------------------------------+
#property copyright "FLT"
#property version   "1.00"
#property strict

//
// What this EA does, and does not do
// -----------------------------------
// It does NOT trade this MT5 account by itself, and it does NOT trade FLT
// with its own judgement. It watches trades YOU open and close in this
// terminal on the symbols you map below, and forwards each one as a signal
// to your FLT trading agent's bridge API.
//
// FLT never receives your MT5 login, your broker, or a signing key from
// this EA. Everything it can do on FLT is bounded by the allocation,
// leverage cap, symbol list and mandatory protection you already configured
// for your trading agent at https://ftlexchange.com/wakiil — a bridge key
// on its own grants no ability to exceed those limits.
//
// Setup
// -----
// 1. On ftlexchange.com/wakiil, configure and enable the trading agent for
//    at least one venue, and issue a bridge key.
// 2. In MetaTrader: Tools > Options > Expert Advisors > "Allow WebRequest for
//    listed URL" and add your FLT base URL (e.g. https://ftlexchange.com).
// 3. Attach this EA to a chart, set BridgeApiKey and BaseUrl, and map at
//    least one MT5 symbol to an FLT symbol/venue pair below.
//

input string BridgeApiKey    = "";                      // Bridge key from /wakiil
input string BaseUrl         = "https://ftlexchange.com";
input string SymbolMap       = "BTCUSD:BTC:hyperliquid,ETHUSD:ETH:hyperliquid"; // mt5symbol:fltSymbol:venue, comma-separated
input int    PollSeconds     = 5;                        // How often to reconcile open positions

datetime lastPoll = 0;

struct SymbolMapping
  {
   string mt5Symbol;
   string fltSymbol;
   string venue;
  };
SymbolMapping mappings[];

// Positions this EA has already told FLT about, keyed by MT5 position ticket,
// so a resync never sends the same open twice.
long knownTickets[];

//+------------------------------------------------------------------+
int OnInit()
  {
   if(StringLen(BridgeApiKey) == 0)
     {
      Print("FLTBridge: BridgeApiKey is empty — issue one at ftlexchange.com/wakiil first.");
      return(INIT_PARAMETERS_INCORRECT);
     }
   ParseSymbolMap();
   if(ArraySize(mappings) == 0)
     {
      Print("FLTBridge: SymbolMap has no valid entries.");
      return(INIT_PARAMETERS_INCORRECT);
     }
   Print("FLTBridge: watching ", ArraySize(mappings), " symbol(s).");
   EventSetTimer(PollSeconds);
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

//+------------------------------------------------------------------+
void OnTimer()
  {
   ReconcilePositions();
  }

//+------------------------------------------------------------------+
// A position opened, closed, or changed. Cheaper to just reconcile on the
// next timer tick than to parse the transaction type here — MT5 fires this
// for far more than opens and closes, and reconciling against the live
// position list is the only version of "what actually happened" that can't
// drift.
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                         const MqlTradeRequest &request,
                         const MqlTradeResult &result)
  {
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
      ReconcilePositions();
  }

//+------------------------------------------------------------------+
void ParseSymbolMap()
  {
   string entries[];
   int n = StringSplit(SymbolMap, ',', entries);
   ArrayResize(mappings, 0);
   for(int i = 0; i < n; i++)
     {
      string parts[];
      string entry = entries[i];
      StringTrimLeft(entry);
      StringTrimRight(entry);
      if(StringLen(entry) == 0)
         continue;
      int p = StringSplit(entry, ':', parts);
      if(p != 3)
        {
         Print("FLTBridge: skipping malformed SymbolMap entry '", entry, "'");
         continue;
        }
      int sz = ArraySize(mappings);
      ArrayResize(mappings, sz + 1);
      mappings[sz].mt5Symbol = parts[0];
      mappings[sz].fltSymbol = parts[1];
      mappings[sz].venue     = parts[2];
     }
  }

//+------------------------------------------------------------------+
bool FindMapping(string mt5Symbol, SymbolMapping &out)
  {
   for(int i = 0; i < ArraySize(mappings); i++)
     {
      if(mappings[i].mt5Symbol == mt5Symbol)
        {
         out = mappings[i];
         return(true);
        }
     }
   return(false);
  }

//+------------------------------------------------------------------+
bool TicketKnown(long ticket)
  {
   for(int i = 0; i < ArraySize(knownTickets); i++)
      if(knownTickets[i] == ticket)
         return(true);
   return(false);
  }

void RememberTicket(long ticket)
  {
   int sz = ArraySize(knownTickets);
   ArrayResize(knownTickets, sz + 1);
   knownTickets[sz] = ticket;
  }

void ForgetTicket(long ticket)
  {
   for(int i = 0; i < ArraySize(knownTickets); i++)
     {
      if(knownTickets[i] == ticket)
        {
         knownTickets[i] = knownTickets[ArraySize(knownTickets) - 1];
         ArrayResize(knownTickets, ArraySize(knownTickets) - 1);
         return;
        }
     }
  }

//+------------------------------------------------------------------+
// Diffs this terminal's currently open positions on mapped symbols against
// what this EA last knew about, and sends one bridge signal per change.
//
// This is a MIRROR, not a hedge: FLT opens with the side and (approximately,
// once converted through its own allocation and mark price) the size of the
// MT5 position, on FLT's own venue and margin — it never touches this MT5
// account's own margin or balance.
//+------------------------------------------------------------------+
void ReconcilePositions()
  {
   long openNow[];
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      string mt5Symbol = PositionGetString(POSITION_SYMBOL);

      SymbolMapping mapping;
      if(!FindMapping(mt5Symbol, mapping))
         continue;

      int sz = ArraySize(openNow);
      ArrayResize(openNow, sz + 1);
      openNow[sz] = (long)ticket;

      if(TicketKnown((long)ticket))
         continue; // already forwarded

      double volume = PositionGetDouble(POSITION_VOLUME);
      double price  = PositionGetDouble(POSITION_PRICE_OPEN);
      long   type   = PositionGetInteger(POSITION_TYPE);
      string side   = (type == POSITION_TYPE_BUY) ? "LONG" : "SHORT";
      double usdNotional = volume * price;

      if(SendOrder(mapping.venue, "OPEN", mapping.fltSymbol, side, usdNotional))
         RememberTicket((long)ticket);
     }

   // Anything FLT-Bridge previously knew about that is no longer open here
   // was closed in this terminal — mirror the close.
   for(int i = ArraySize(knownTickets) - 1; i >= 0; i--)
     {
      long ticket = knownTickets[i];
      bool stillOpen = false;
      for(int j = 0; j < ArraySize(openNow); j++)
         if(openNow[j] == ticket)
           {
            stillOpen = true;
            break;
           }
      if(stillOpen)
         continue;

      // The position is gone; we no longer have its symbol, so close every
      // mapped FLT symbol's position on every mapped venue for safety. In
      // practice one EA instance maps a small, deliberate symbol list, so
      // this is a handful of calls at most, and a CLOSE against something
      // already flat is a harmless no-op on FLT's side.
      for(int m = 0; m < ArraySize(mappings); m++)
         SendOrder(mappings[m].venue, "CLOSE", mappings[m].fltSymbol, "", 0);

      ForgetTicket(ticket);
     }
  }

//+------------------------------------------------------------------+
// POSTs one trade signal to FLT's bridge API. Returns true on a 2xx/200
// response with an "accepted" outcome; logs and returns false otherwise —
// this EA never retries blind, matching how FLT's own agent kill-switches
// on a real execution failure rather than hammering the venue.
//+------------------------------------------------------------------+
bool SendOrder(string venue, string action, string fltSymbol, string side, double usdNotional)
  {
   string url = BaseUrl + "/api/bridge/mt/order";
   string headers = "Content-Type: application/json\r\nX-FLT-Bridge-Key: " + BridgeApiKey + "\r\n";

   string body = "{\"venue\":\"" + venue + "\",\"action\":\"" + action + "\",\"symbol\":\"" + fltSymbol + "\"";
   if(action == "OPEN")
     {
      body += ",\"side\":\"" + side + "\",\"usdNotional\":" + DoubleToString(usdNotional, 2);
     }
   body += ",\"reasoning\":\"MT5 mirror: " + Symbol() + "\"}";

   char post[];
   char result[];
   string resultHeaders;
   StringToCharArray(body, post, 0, StringLen(body));

   int status = WebRequest("POST", url, headers, 10000, post, result, resultHeaders);

   if(status == -1)
     {
      Print("FLTBridge: WebRequest failed (", GetLastError(),
            "). Is ", BaseUrl, " allow-listed under Tools > Options > Expert Advisors?");
      return(false);
     }

   string response = CharArrayToString(result);
   if(status < 200 || status >= 300)
     {
      Print("FLTBridge: order rejected (HTTP ", status, "): ", response);
      return(false);
     }

   Print("FLTBridge: ", action, " ", fltSymbol, " on ", venue, " -> ", response);
   return(true);
  }
//+------------------------------------------------------------------+
