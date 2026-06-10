import { useParams } from 'react-router-dom';
import AgentWorkspace from './AgentWorkspace';
import RecoWorkspace from './RecoWorkspace';
import RecoMultiStateWorkspace from './RecoMultiStateWorkspace';

// Stable UUIDs assigned by seed.js — one per RECO agent
export const RECO_ID_TO_TYPE = {
  'd0000000-0000-0000-0000-000000000001': 'gstr_2b_books',
  'd0000000-0000-0000-0000-000000000002': 'gstr_2b_books_multistate',
  'd0000000-0000-0000-0000-000000000003': 'gstr_3b_tally_entry',
  'd0000000-0000-0000-0000-000000000004': 'universal_bank_statement',
  'd0000000-0000-0000-0000-000000000005': 'gstr_1_vs_books',
};

export default function AgentDispatch() {
  const { agentId } = useParams();
  const recoType = RECO_ID_TO_TYPE[agentId];

  if (recoType === 'gstr_2b_books_multistate') return <RecoMultiStateWorkspace />;
  if (recoType) return <RecoWorkspace agentTypeProp={recoType} />;
  return <AgentWorkspace />;
}
