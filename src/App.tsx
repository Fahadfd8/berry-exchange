/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  doc, 
  setDoc, 
  updateDoc,
  onSnapshot, 
  serverTimestamp,
  collection,
  addDoc,
  runTransaction,
  query,
  where,
  User 
} from './firebase';
import { LogIn, LogOut, TrendingUp, Wallet, Briefcase, Loader2, AlertCircle, Coins, Plus, Minus, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Error Handling ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null;
    emailVerified: boolean;
    isAnonymous: boolean;
    tenantId: string | null;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified || false,
      isAnonymous: auth.currentUser?.isAnonymous || false,
      tenantId: auth.currentUser?.tenantId || null,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Components ---

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    (this as any).state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    const { hasError, error } = (this as any).state;
    if (hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#0A0A0A] p-4 text-white">
          <div className="max-w-md w-full bg-[#141414] rounded-2xl shadow-2xl p-8 border border-red-900/30">
            <div className="flex items-center gap-3 text-red-500 mb-4">
              <AlertCircle size={32} />
              <h2 className="text-2xl font-bold">System Error</h2>
            </div>
            <p className="text-gray-400 mb-6">
              The exchange encountered a critical error. Please refresh.
            </p>
            <pre className="bg-black/50 p-4 rounded-lg text-xs overflow-auto max-h-40 mb-6 text-red-400 border border-red-900/20">
              {error?.message}
            </pre>
            <button 
              onClick={() => window.location.reload()}
              className="w-full bg-red-600 text-white py-3 rounded-xl font-semibold hover:bg-red-700 transition-colors"
            >
              Restart System
            </button>
          </div>
        </div>
      );
    }
    return (this as any).props.children;
  }
}

interface GameUser {
  uid: string;
  display_name: string;
  email: string;
  photo_url: string;
  starting_balance: number;
  cash_balance: number;
  holdings_value?: number;
  total_portfolio_value?: number;
  created_at: any;
}

interface Character {
  id: string;
  name: string;
  image_url: string;
  current_price: number;
  previous_price: number;
  active: boolean;
  created_at: any;
}

interface Holding {
  user_id: string;
  character_id: string;
  character_name: string;
  quantity: number;
  avg_buy_price: number;
  updated_at: any;
}

interface Transaction {
  user_id: string;
  character_id: string;
  character_name: string;
  type: 'buy' | 'sell';
  quantity: number;
  price: number;
  total: number;
  created_at: any;
}

const SEED_CHARACTERS = [
  { name: 'Monkey D. Luffy', price: 5000, image: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Luffy' },
  { name: 'Roronoa Zoro', price: 4500, image: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Zoro' },
  { name: 'Vinsmoke Sanji', price: 4200, image: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Sanji' },
  { name: 'Red-Haired Shanks', price: 8500, image: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Shanks' },
  { name: 'Marshall D. Teach', price: 7800, image: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Blackbeard' },
];

interface StockCardProps {
  character: Character;
  cashBalance: number;
  holdings: Holding[];
  key?: any;
}

function StockCard({ character, cashBalance, holdings }: StockCardProps) {
  const [quantity, setQuantity] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success_buy' | 'success_sell'>('idle');
  
  const priceChange = character.current_price - character.previous_price;
  const percentChange = ((priceChange / character.previous_price) * 100).toFixed(2);
  const isPositive = priceChange >= 0;
  const totalCost = character.current_price * quantity;
  const canAfford = cashBalance >= totalCost;

  const currentHolding = holdings.find(h => h.character_id === character.id);
  const ownedQuantity = currentHolding?.quantity || 0;
  const canSell = ownedQuantity >= quantity;

  const handleBuy = async () => {
    if (!auth.currentUser || !canAfford || quantity < 1) return;
    
    setIsProcessing(true);
    const userId = auth.currentUser.uid;
    const userRef = doc(db, 'users', userId);
    const holdingId = `${userId}_${character.id}`;
    const holdingRef = doc(db, 'holdings', holdingId);
    const transactionRef = doc(collection(db, 'transactions'));

    try {
      await runTransaction(db, async (transaction) => {
        const userSnap = await transaction.get(userRef);
        if (!userSnap.exists()) throw new Error("User not found");
        
        const userData = userSnap.data() as GameUser;
        const currentCash = userData.cash_balance ?? 10000;
        if (currentCash < totalCost) throw new Error("Insufficient balance");

        const holdingSnap = await transaction.get(holdingRef);
        
        // 1. Update User Balance & Backfill missing fields
        const userUpdates: any = {
          cash_balance: currentCash - totalCost
        };
        if (!userData.uid) userUpdates.uid = userId;
        if (!userData.email) userUpdates.email = auth.currentUser?.email || '';
        if (userData.starting_balance === undefined) userUpdates.starting_balance = 10000;
        if (!userData.created_at) userUpdates.created_at = serverTimestamp();

        transaction.update(userRef, userUpdates);

        // 2. Update or Create Holding
        if (holdingSnap.exists()) {
          const oldHolding = holdingSnap.data() as Holding;
          const newTotalQty = oldHolding.quantity + quantity;
          const newAvgPrice = ((oldHolding.quantity * (oldHolding.avg_buy_price || character.current_price)) + (quantity * character.current_price)) / newTotalQty;
          
          const holdingUpdates: any = {
            quantity: newTotalQty,
            avg_buy_price: newAvgPrice,
            updated_at: serverTimestamp()
          };
          if (!oldHolding.user_id) holdingUpdates.user_id = userId;
          if (!oldHolding.character_id) holdingUpdates.character_id = character.id;
          if (!oldHolding.character_name) holdingUpdates.character_name = character.name;

          transaction.update(holdingRef, holdingUpdates);
        } else {
          const newHolding: Holding = {
            user_id: userId,
            character_id: character.id,
            character_name: character.name,
            quantity: quantity,
            avg_buy_price: character.current_price,
            updated_at: serverTimestamp()
          };
          transaction.set(holdingRef, newHolding);
        }

        // 3. Create Transaction Record
        const newTrade: Transaction = {
          user_id: userId,
          character_id: character.id,
          character_name: character.name,
          type: 'buy',
          quantity: quantity,
          price: character.current_price,
          total: totalCost,
          created_at: serverTimestamp()
        };
        transaction.set(transactionRef, newTrade);
      });

      setStatus('success_buy');
      setQuantity(1);
      setTimeout(() => setStatus('idle'), 3000);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'transactions');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSell = async () => {
    if (!auth.currentUser || !canSell || quantity < 1) return;
    
    setIsProcessing(true);
    const userId = auth.currentUser.uid;
    const userRef = doc(db, 'users', userId);
    const holdingId = `${userId}_${character.id}`;
    const holdingRef = doc(db, 'holdings', holdingId);
    const transactionRef = doc(collection(db, 'transactions'));
    const totalSale = character.current_price * quantity;

    try {
      await runTransaction(db, async (transaction) => {
        const userSnap = await transaction.get(userRef);
        if (!userSnap.exists()) throw new Error("User not found");
        
        const userData = userSnap.data() as GameUser;
        const currentCash = userData.cash_balance ?? 10000;

        const holdingSnap = await transaction.get(holdingRef);
        if (!holdingSnap.exists()) throw new Error("No holdings found to sell");
        
        const currentHoldingData = holdingSnap.data() as Holding;
        if (currentHoldingData.quantity < quantity) throw new Error("Insufficient shares");

        // 1. Update User Balance
        transaction.update(userRef, {
          cash_balance: currentCash + totalSale
        });

        // 2. Update or Delete Holding
        const newQty = currentHoldingData.quantity - quantity;
        if (newQty === 0) {
          transaction.delete(holdingRef);
        } else {
          transaction.update(holdingRef, {
            quantity: newQty,
            updated_at: serverTimestamp()
          });
        }

        // 3. Create Transaction Record
        const newTrade: Transaction = {
          user_id: userId,
          character_id: character.id,
          character_name: character.name,
          type: 'sell',
          quantity: quantity,
          price: character.current_price,
          total: totalSale,
          created_at: serverTimestamp()
        };
        transaction.set(transactionRef, newTrade);
      });

      setStatus('success_sell');
      setQuantity(1);
      setTimeout(() => setStatus('idle'), 3000);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'transactions');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <motion.div 
      whileHover={{ y: -4 }}
      className="bg-[#1A1A1A] rounded-2xl border border-white/5 p-5 flex flex-col gap-5 group transition-all hover:border-purple-500/30 shadow-lg relative overflow-hidden"
    >
      <AnimatePresence>
        {status !== 'idle' && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`absolute inset-0 ${status === 'success_buy' ? 'bg-green-500/90' : 'bg-blue-500/90'} backdrop-blur-sm z-10 flex flex-col items-center justify-center text-white`}
          >
            <CheckCircle2 size={40} className="mb-2" />
            <span className="font-bold">
              {status === 'success_buy' ? 'Purchase Successful!' : 'Sale Successful!'}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-center gap-4">
        <div className="relative">
          <img 
            src={character.image_url} 
            alt={character.name} 
            className="w-16 h-16 rounded-2xl object-cover bg-black/20"
            referrerPolicy="no-referrer"
          />
          <div className={`absolute -bottom-1 -right-1 w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-bold border-2 border-[#1A1A1A] ${isPositive ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}>
            {isPositive ? '▲' : '▼'}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-bold text-base truncate group-hover:text-purple-400 transition-colors">{character.name}</h4>
            {ownedQuantity > 0 && (
              <span className="text-[10px] font-bold bg-white/10 px-2 py-0.5 rounded-full text-gray-400">
                Owned: {ownedQuantity}
              </span>
            )}
          </div>
          <div className={`text-xs font-bold ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
            {percentChange}% change
          </div>
        </div>
      </div>
      
      <div className="flex items-end justify-between bg-black/20 p-3 rounded-xl border border-white/5">
        <div className="flex flex-col">
          <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1">Market Price</span>
          <span className="font-mono font-bold text-xl text-white">{character.current_price.toLocaleString()}</span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1">Total Value</span>
          <span className={`font-mono font-bold text-lg text-white`}>
            {totalCost.toLocaleString()}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 flex items-center bg-white/5 rounded-xl border border-white/10 p-1">
            <button 
              onClick={() => setQuantity(Math.max(1, quantity - 1))}
              className="w-8 h-8 flex items-center justify-center hover:bg-white/5 rounded-lg transition-colors text-gray-400"
            >
              <Minus size={14} />
            </button>
            <input 
              type="number" 
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
              className="flex-1 bg-transparent text-center font-mono font-bold text-sm focus:outline-none"
            />
            <button 
              onClick={() => setQuantity(quantity + 1)}
              className="w-8 h-8 flex items-center justify-center hover:bg-white/5 rounded-lg transition-colors text-gray-400"
            >
              <Plus size={14} />
            </button>
          </div>
          <button 
            onClick={() => setQuantity(ownedQuantity > 0 ? ownedQuantity : 1)}
            className="px-3 h-10 bg-white/5 hover:bg-white/10 text-[10px] font-bold uppercase tracking-widest rounded-xl border border-white/10 transition-colors"
          >
            Max
          </button>
        </div>
        
        <div className="flex gap-2">
          <button 
            onClick={handleBuy}
            disabled={isProcessing || !canAfford}
            className="flex-1 h-10 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-800 disabled:text-gray-500 text-white rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all shadow-lg shadow-purple-500/10 flex items-center justify-center gap-2"
          >
            {isProcessing ? (
              <Loader2 size={16} className="animate-spin" />
            ) : !canAfford ? (
              'No Funds'
            ) : (
              'Buy'
            )}
          </button>
          <button 
            onClick={handleSell}
            disabled={isProcessing || !canSell}
            className="flex-1 h-10 bg-white/5 hover:bg-white/10 disabled:bg-gray-800/50 disabled:text-gray-600 disabled:border-transparent text-white rounded-xl text-[10px] font-bold uppercase tracking-widest border border-white/10 transition-all flex items-center justify-center gap-2"
          >
            {isProcessing ? (
              <Loader2 size={16} className="animate-spin" />
            ) : !canSell ? (
              'No Stock'
            ) : (
              'Sell'
            )}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

type Tab = 'market' | 'portfolio' | 'leaderboard';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [gameUser, setGameUser] = useState<GameUser | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [leaderboard, setLeaderboard] = useState<GameUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [marketLoading, setMarketLoading] = useState(true);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('market');

  const currentHoldingsValue = holdings.reduce((total, holding) => {
    const char = characters.find(c => c.id === holding.character_id);
    const price = char?.current_price || holding.avg_buy_price;
    return total + (holding.quantity * price);
  }, 0);

  const totalPortfolioValue = (gameUser?.cash_balance ?? 10000) + currentHoldingsValue;

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (!currentUser) {
        setGameUser(null);
        setCharacters([]);
        setLoading(false);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;

    const path = `users/${user.uid}`;
    const unsubscribe = onSnapshot(doc(db, 'users', user.uid), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as GameUser;
        setGameUser(data);

        // Backfill missing fields for existing users safely
        const updates: any = {};
        if (data.starting_balance === undefined || data.starting_balance === null) {
          updates.starting_balance = 10000;
        }
        if (data.cash_balance === undefined || data.cash_balance === null) {
          updates.cash_balance = 10000;
        }
        if (data.holdings_value === undefined || data.holdings_value === null) {
          updates.holdings_value = 0;
        }
        if (data.total_portfolio_value === undefined || data.total_portfolio_value === null) {
          updates.total_portfolio_value = data.cash_balance ?? 10000;
        }
        if (!data.uid) {
          updates.uid = user.uid;
        }
        if (!data.email) {
          updates.email = user.email || '';
        }
        if (!data.created_at) {
          updates.created_at = serverTimestamp();
        }

        if (Object.keys(updates).length > 0) {
          updateDoc(doc(db, 'users', user.uid), updates)
            .catch(err => {
              // Only log if it's not a permission error we're already handling
              if (!(err instanceof Error && err.message.includes('insufficient permissions'))) {
                console.error('Backfill failed:', err);
              }
            });
        }
      } else {
        // Initialize new game user
        const newUser: GameUser = {
          uid: user.uid,
          display_name: user.displayName || 'Berry Trader',
          email: user.email || '',
          photo_url: user.photoURL || '',
          starting_balance: 10000,
          cash_balance: 10000,
          holdings_value: 0,
          total_portfolio_value: 10000,
          created_at: serverTimestamp(),
        };
        setDoc(doc(db, 'users', user.uid), newUser)
          .catch(err => handleFirestoreError(err, OperationType.CREATE, path));
      }
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    });

    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (!user) return;

    const charactersPath = 'characters';
    const unsubscribe = onSnapshot(collection(db, 'characters'), (snapshot) => {
      if (snapshot.empty) {
        // Seed characters if none exist
        SEED_CHARACTERS.forEach(async (char) => {
          try {
            await addDoc(collection(db, 'characters'), {
              id: char.name.toLowerCase().replace(/\s+/g, '-'),
              name: char.name,
              image_url: char.image,
              current_price: char.price,
              previous_price: char.price * 0.95, // Mock previous price
              active: true,
              created_at: serverTimestamp(),
            });
          } catch (err) {
            console.error('Seeding failed:', err);
          }
        });
      } else {
        const charList = snapshot.docs.map(doc => doc.data() as Character);
        setCharacters(charList.filter(c => c.active));
      }
      setMarketLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, charactersPath);
    });

    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (!user) return;

    const holdingsPath = 'holdings';
    const q = query(collection(db, 'holdings'), where('user_id', '==', user.uid));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const holdingsList = snapshot.docs.map(doc => doc.data() as Holding);
      setHoldings(holdingsList);
      setHoldingsLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, holdingsPath);
    });

    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (!user || marketLoading || holdingsLoading || !gameUser) return;

    const currentHoldingsVal = holdings.reduce((total, holding) => {
      const char = characters.find(c => c.id === holding.character_id);
      const price = char?.current_price || holding.avg_buy_price;
      return total + (holding.quantity * price);
    }, 0);

    const totalVal = (gameUser.cash_balance ?? 10000) + currentHoldingsVal;

    // Only update if values have actually changed to avoid infinite loops
    if (gameUser.holdings_value !== currentHoldingsVal || gameUser.total_portfolio_value !== totalVal) {
      const userRef = doc(db, 'users', user.uid);
      updateDoc(userRef, {
        holdings_value: currentHoldingsVal,
        total_portfolio_value: totalVal
      }).catch(err => {
        if (!(err instanceof Error && err.message.includes('insufficient permissions'))) {
          console.error('Portfolio update failed:', err);
        }
      });
    }
  }, [holdings, characters, user, marketLoading, holdingsLoading, gameUser]);

  useEffect(() => {
    if (!user) return;

    const usersPath = 'users';
    const unsubscribe = onSnapshot(collection(db, 'users'), (snapshot) => {
      const usersList = snapshot.docs.map(doc => doc.data() as GameUser);
      // Sort by total_portfolio_value descending
      const sorted = usersList
        .filter(u => u.total_portfolio_value !== undefined)
        .sort((a, b) => (b.total_portfolio_value || 0) - (a.total_portfolio_value || 0));
      setLeaderboard(sorted);
      setLeaderboardLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, usersPath);
    });

    return () => unsubscribe();
  }, [user]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0A0A0A]">
        <Loader2 className="animate-spin text-purple-500" size={48} />
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-[#0A0A0A] text-gray-100 font-sans selection:bg-purple-500/30">
        {/* Navigation */}
        <nav className="border-b border-white/5 bg-[#0A0A0A]/80 backdrop-blur-xl sticky top-0 z-50">
          <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-purple-600 to-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-purple-500/20">
                <TrendingUp size={22} className="text-white" />
              </div>
              <span className="font-bold text-xl tracking-tight bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
                Berry Exchange
              </span>
            </div>

            {user && (
              <div className="hidden md:flex items-center gap-1 bg-white/5 p-1 rounded-xl border border-white/10">
                <button 
                  onClick={() => setActiveTab('market')}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'market' ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                >
                  Market
                </button>
                <button 
                  onClick={() => setActiveTab('portfolio')}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'portfolio' ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                >
                  Portfolio
                </button>
                <button 
                  onClick={() => setActiveTab('leaderboard')}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'leaderboard' ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                >
                  Leaderboard
                </button>
              </div>
            )}

            {user && (
              <div className="flex items-center gap-6">
                <div className="hidden md:flex items-center gap-2 bg-white/5 px-4 py-1.5 rounded-full border border-white/10">
                  <Coins size={16} className="text-yellow-500" />
                  <span className="text-sm font-mono font-bold text-yellow-500">
                    {(gameUser?.cash_balance ?? 10000).toLocaleString()}
                  </span>
                </div>
                <button 
                  onClick={handleLogout}
                  className="flex items-center gap-2 text-sm font-medium text-gray-400 hover:text-white transition-colors"
                >
                  <LogOut size={18} />
                  <span className="hidden sm:inline">Logout</span>
                </button>
              </div>
            )}
          </div>
        </nav>

        {/* Mobile Navigation */}
        {user && (
          <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#0A0A0A]/90 backdrop-blur-xl border-t border-white/5 p-2">
            <div className="flex items-center justify-around gap-1">
              <button 
                onClick={() => setActiveTab('market')}
                className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-xl transition-all ${activeTab === 'market' ? 'text-purple-500 bg-purple-500/10' : 'text-gray-500'}`}
              >
                <TrendingUp size={20} />
                <span className="text-[10px] font-bold uppercase tracking-widest">Market</span>
              </button>
              <button 
                onClick={() => setActiveTab('portfolio')}
                className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-xl transition-all ${activeTab === 'portfolio' ? 'text-purple-500 bg-purple-500/10' : 'text-gray-500'}`}
              >
                <Briefcase size={20} />
                <span className="text-[10px] font-bold uppercase tracking-widest">Portfolio</span>
              </button>
              <button 
                onClick={() => setActiveTab('leaderboard')}
                className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-xl transition-all ${activeTab === 'leaderboard' ? 'text-purple-500 bg-purple-500/10' : 'text-gray-500'}`}
              >
                <TrendingUp size={20} className="rotate-90" />
                <span className="text-[10px] font-bold uppercase tracking-widest">Board</span>
              </button>
            </div>
          </div>
        )}

        <main className={`max-w-6xl mx-auto px-6 py-12 ${user ? 'pb-24 md:pb-12' : 'py-12'}`}>
          <AnimatePresence mode="wait">
            {!user ? (
              <motion.div 
                key="landing"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                className="flex flex-col items-center justify-center py-24 text-center"
              >
                <div className="inline-block px-4 py-1.5 mb-6 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-400 text-xs font-bold uppercase tracking-widest">
                  Alpha Access
                </div>
                <h1 className="text-6xl md:text-8xl font-black tracking-tighter mb-6 leading-[0.9]">
                  BERRY<br />EXCHANGE
                </h1>
                <p className="text-xl text-gray-400 max-w-xl mx-auto mb-12 leading-relaxed">
                  A character stock market game powered by berries. Trade your favorites, build your portfolio, and dominate the market.
                </p>
                <button 
                  onClick={handleLogin}
                  className="flex items-center gap-3 bg-white text-black px-10 py-4 rounded-2xl text-lg font-bold hover:bg-gray-200 transition-all shadow-2xl shadow-white/10 active:scale-95"
                >
                  <LogIn size={24} />
                  Sign in with Google
                </button>
              </motion.div>
            ) : (
              <motion.div 
                key={activeTab}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-8"
              >
                {activeTab === 'market' && (
                  <div className="space-y-8">
                    {/* Header */}
                    <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                      <div>
                        <h2 className="text-sm font-bold uppercase tracking-widest text-purple-500 mb-2">Market</h2>
                        <h1 className="text-4xl font-bold tracking-tight">
                          Welcome back, {gameUser?.display_name?.split(' ')[0]}
                        </h1>
                      </div>
                      <div className="flex items-center gap-8">
                        <div className="flex flex-col items-end">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Available Cash</span>
                          <span className="text-3xl font-mono font-bold text-white">
                            {(gameUser?.cash_balance ?? 10000).toLocaleString()} <span className="text-sm text-gray-500">BERRIES</span>
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="bg-[#141414] rounded-3xl border border-white/5 p-8 flex flex-col min-h-[400px]">
                      <div className="flex items-center justify-between mb-8">
                        <div className="flex items-center gap-3">
                          <TrendingUp size={20} className="text-purple-500" />
                          <h3 className="font-bold text-lg">Market Overview</h3>
                        </div>
                        <span className="text-xs font-medium text-gray-500">Live Updates</span>
                      </div>
                      
                      {marketLoading ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-center border-2 border-dashed border-white/5 rounded-2xl">
                          <Loader2 size={24} className="text-gray-600 animate-spin mb-4" />
                          <p className="text-gray-500 font-medium">Fetching market data...</p>
                        </div>
                      ) : characters.length > 0 ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                          {characters.map((char) => (
                            <StockCard 
                              key={char.id} 
                              character={char} 
                              cashBalance={gameUser?.cash_balance ?? 10000} 
                              holdings={holdings}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-center border-2 border-dashed border-white/5 rounded-2xl">
                          <div className="w-12 h-12 bg-white/5 rounded-full flex items-center justify-center mb-4">
                            <Loader2 size={24} className="text-gray-600 animate-pulse" />
                          </div>
                          <p className="text-gray-500 font-medium">Market data initialization in progress...</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === 'portfolio' && (
                  <div className="space-y-8">
                    {/* Header */}
                    <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                      <div>
                        <h2 className="text-sm font-bold uppercase tracking-widest text-purple-500 mb-2">Portfolio</h2>
                        <h1 className="text-4xl font-bold tracking-tight">Your Assets</h1>
                      </div>
                      <div className="flex items-center gap-8">
                        <div className="flex flex-col items-end">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Portfolio Value</span>
                          <span className="text-3xl font-mono font-bold text-white">
                            {totalPortfolioValue.toLocaleString()} <span className="text-sm text-gray-500">BERRIES</span>
                          </span>
                          <div className="flex gap-4 mt-1">
                            <div className="flex items-center gap-1.5">
                              <div className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Cash: {(gameUser?.cash_balance ?? 0).toLocaleString()}</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Holdings: {currentHoldingsValue.toLocaleString()}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="bg-[#141414] rounded-3xl border border-white/5 p-8 flex flex-col min-h-[400px]">
                      <div className="flex items-center gap-3 mb-8">
                        <Briefcase size={20} className="text-blue-500" />
                        <h3 className="font-bold text-lg">Active Positions</h3>
                      </div>
                      
                      {holdingsLoading ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-center border-2 border-dashed border-white/5 rounded-2xl">
                          <Loader2 size={24} className="text-gray-600 animate-spin mb-4" />
                          <p className="text-gray-500 font-medium">Loading holdings...</p>
                        </div>
                      ) : holdings.length > 0 ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {holdings.map((holding) => {
                            const char = characters.find(c => c.id === holding.character_id);
                            const currentPrice = char?.current_price || holding.avg_buy_price;
                            const currentValue = holding.quantity * currentPrice;
                            const profit = currentValue - (holding.quantity * holding.avg_buy_price);
                            const isProfit = profit >= 0;

                            return (
                              <div key={holding.character_id} className="bg-white/5 rounded-2xl p-6 border border-white/5 flex flex-col gap-4">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 bg-white/5 rounded-xl flex items-center justify-center">
                                      <Briefcase size={20} className="text-blue-500" />
                                    </div>
                                    <div>
                                      <h4 className="font-bold text-lg">{holding.character_name}</h4>
                                      <div className="text-xs text-gray-500 font-medium uppercase tracking-wider">
                                        {holding.quantity} Shares
                                      </div>
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <div className="text-xl font-mono font-bold text-white">
                                      {currentValue.toLocaleString()}
                                    </div>
                                    <div className={`text-[10px] font-bold uppercase tracking-widest ${isProfit ? 'text-green-500' : 'text-red-500'}`}>
                                      {isProfit ? '+' : ''}{profit.toLocaleString()} ({((profit / (holding.quantity * holding.avg_buy_price)) * 100).toFixed(2)}%)
                                    </div>
                                  </div>
                                </div>
                                <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/5">
                                  <div>
                                    <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Avg Buy Price</div>
                                    <div className="font-mono font-bold text-sm text-gray-300">{Math.round(holding.avg_buy_price).toLocaleString()}</div>
                                  </div>
                                  <div className="text-right">
                                    <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Current Price</div>
                                    <div className="font-mono font-bold text-sm text-gray-300">{currentPrice.toLocaleString()}</div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-center border-2 border-dashed border-white/5 rounded-2xl">
                          <div className="w-12 h-12 bg-white/5 rounded-full flex items-center justify-center mb-4">
                            <Wallet size={24} className="text-gray-600" />
                          </div>
                          <p className="text-gray-500 font-medium">No active positions</p>
                          <p className="text-xs text-gray-600 mt-1">Visit the market to start trading.</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === 'leaderboard' && (
                  <div className="space-y-8">
                    {/* Header */}
                    <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                      <div>
                        <h2 className="text-sm font-bold uppercase tracking-widest text-purple-500 mb-2">Leaderboard</h2>
                        <h1 className="text-4xl font-bold tracking-tight">Top Traders</h1>
                      </div>
                    </div>

                    <div className="bg-[#141414] rounded-3xl border border-white/5 p-8 flex flex-col min-h-[400px]">
                      <div className="flex items-center gap-3 mb-8">
                        <TrendingUp size={20} className="text-yellow-500" />
                        <h3 className="font-bold text-lg">Global Rankings</h3>
                      </div>
                      
                      {leaderboardLoading ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-center border-2 border-dashed border-white/5 rounded-2xl">
                          <Loader2 size={24} className="text-gray-600 animate-spin mb-4" />
                          <p className="text-gray-500 font-medium">Calculating ranks...</p>
                        </div>
                      ) : leaderboard.length > 0 ? (
                        <div className="space-y-3">
                          {leaderboard.map((user, index) => (
                            <div key={user.uid} className={`bg-white/5 rounded-2xl p-6 border ${user.uid === auth.currentUser?.uid ? 'border-purple-500/50 bg-purple-500/5' : 'border-white/5'} flex items-center justify-between transition-all hover:bg-white/[0.07]`}>
                              <div className="flex items-center gap-6">
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold ${index === 0 ? 'bg-yellow-500 text-black shadow-lg shadow-yellow-500/20' : index === 1 ? 'bg-gray-300 text-black shadow-lg shadow-gray-300/20' : index === 2 ? 'bg-orange-500 text-black shadow-lg shadow-orange-500/20' : 'bg-white/10 text-gray-400'}`}>
                                  {index + 1}
                                </div>
                                <div className="flex items-center gap-4">
                                  <img 
                                    src={user.photo_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.uid}`} 
                                    alt={user.display_name} 
                                    className="w-12 h-12 rounded-xl bg-black/20"
                                    referrerPolicy="no-referrer"
                                  />
                                  <div>
                                    <h4 className="font-bold text-lg flex items-center gap-2">
                                      {user.display_name}
                                      {user.uid === auth.currentUser?.uid && (
                                        <span className="text-[10px] font-bold bg-purple-500 text-white px-2 py-0.5 rounded-full uppercase tracking-widest">You</span>
                                      )}
                                    </h4>
                                    <div className="text-xs text-gray-500 font-medium uppercase tracking-wider mt-0.5">
                                      Active Trader
                                    </div>
                                  </div>
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-2xl font-mono font-bold text-white">
                                  {(user.total_portfolio_value || 0).toLocaleString()}
                                </div>
                                <div className="text-[10px] text-gray-500 uppercase tracking-widest mt-1">Total Portfolio Value</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-center border-2 border-dashed border-white/5 rounded-2xl">
                          <p className="text-gray-500 font-medium">No traders yet</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        <footer className="py-12 border-t border-white/5 mt-20 pb-32 md:pb-12">
          <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-2 opacity-50">
              <TrendingUp size={16} />
              <span className="text-xs font-bold uppercase tracking-widest">Berry Exchange v0.1.0</span>
            </div>
            <div className="flex gap-8">
              <a href="#" className="text-gray-500 hover:text-white text-xs font-bold uppercase tracking-widest transition-colors">Docs</a>
              <a href="#" className="text-gray-500 hover:text-white text-xs font-bold uppercase tracking-widest transition-colors">API</a>
              <a href="#" className="text-gray-500 hover:text-white text-xs font-bold uppercase tracking-widest transition-colors">Support</a>
            </div>
          </div>
        </footer>
      </div>
    </ErrorBoundary>
  );
}
