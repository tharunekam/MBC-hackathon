# 🎬 Hackathon Demo Script: Living Tokens (3-Minute Walkthrough)

*Target Audience: Gemini & Solana Hackathon Judges*  
*Tone: Sharp, energetic, economically grounded, and visually compelling.*

---

## ⏱️ Minute 0:00 - 0:45 | The Hook & The Problem

> "Judges, prediction markets are the single most accurate source of forward-looking truth in the world. But right now, they are trapped in institutional orderbooks. If you are a fan, a gamer, or an NFT collector, you don’t want to stare at a CLOB orderbook all day.
> 
> Meanwhile, when communities create tokens on Solana, they launch fragmented AMM pools with zero underlying liquidity, zero hedging, and zero connection to real prediction markets.
> 
> **Welcome to Living Tokens.** 
> We turn Gemini prediction markets into programmable assets on Solana. A token can react to the odds, a collectible can remember when you believed, and a trophy can award itself to the winner. Best of all: **they all share the exact same underlying liquidity pool, and every single trade flows directly back to Gemini.**"

---

## ⏱️ Minute 0:45 - 1:45 | The 3 Living Objects Live Demo

*(Switch screen to the dApp interface: Texas Longhorns vs Rival)*

> "Look at our live Event Space. Texas is currently an **8% underdog** on Gemini. Notice three distinct objects living inside this single event:
>
> 1. **$HORNS (The Living Token):**
>    I hold 100 outcome shares. Thanks to Solana's **Token-2022 Scaled UI Amount**, my wallet currently displays **8 $HORNS**. It’s in the *Underdog* visual tier with a dark, gritty bronze aesthetic.
>
> 2. **The Underdog Stamp:**
>    Because Texas is under 10%, the **Underdog Mint Window is open**. I click *Mint Stamp*. It wraps 20 of my YES claims into a commemorative NFT. Sealed into its metadata onchain is the exact timestamp and entry odds: **8.2%**. If Texas wins, this stamp unwraps for 20 USDC. If they lose, it’s a permanent soulbound souvenir of my belief before the comeback.
>
> 3. **The Autonomous Trophy:**
>    Locked in our Solana escrow program is the Rivalry Trophy NFT plus a 500 USDC prize purse, programmed to autonomously fly to the winning alumni DAO treasury the instant Gemini settles."

---

## ⏱️ Minute 1:45 - 2:30 | Under the Hood: Shared Liquidity & Gemini Flow

*(Switch screen to the Proof-of-Backing & Hedge Terminal)*

> "Now look at the real innovation: **Shared Liquidity & Value Accrual.**
> 
> When I bought those $HORNS and minted that Stamp, did we have to spin up three different Uniswap-style pools? **No.**
> Both assets tap into one canonical split-and-merge vault: `1 USDC = 1 YES + 1 NO`.
>
> Watch what just happened under the hood:
> 1. My purchase created a net 120-claim YES imbalance on Solana.
> 2. **QuickNode Streams** detected the confirmed Solana instruction and shot a webhook to our Hedge Engine in **under 200 milliseconds**.
> 3. The Hedge Engine instantly executed an authenticated buy order on **Gemini's CLOB** for 120 Texas YES contracts, tagged with our sub-broker client ID `gemini-client: living-tokens-v1`.
> 
> **Gemini earned direct taker fee revenue, captured genuine external retail volume, and expanded its distribution to a user who never had to leave their Solana wallet.**"

---

## ⏱️ Minute 2:30 - 3:00 | The Climax: The Odds Move & Settlement

*(Trigger simulated in-game comeback: Texas odds shift from 8% → 45%)*

> "Texas scores. Live Gemini odds jump to 45%. Look at the magic:
> - My $HORNS balance **swells from 8 to 45 $HORNS right inside my wallet** without any inflationary token dilution.
> - The Underdog Stamp minting **automatically closes**. Early believers now hold an exclusive, provable relic.
> - When the final whistle blows and Gemini settles `YES`, the Trophy autonomously transfers to the Texas Treasury, and every $HORNS claim redeems 1:1 for USDC directly from our Solana vault.
> 
> **Living Tokens turns Gemini prediction markets into living onchain economies. Thank you!**"
