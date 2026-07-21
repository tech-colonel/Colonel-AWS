import { useParams } from 'react-router-dom';
import AgentWorkspace from './AgentWorkspace';
import RecoWorkspace from './RecoWorkspace';
import RecoMultiStateWorkspace from './RecoMultiStateWorkspace';
import MtrWorkspace from './MtrWorkspace';
import PdfBankExtractorWorkspace from './PdfBankExtractorWorkspace';
import MyntraTicketFinderWorkspace from './MyntraTicketFinderWorkspace';
import Gstr3bTallyWorkspace from './Gstr3bTallyWorkspace';

// Stable UUIDs assigned by seed.js — one per RECO agent
export const RECO_ID_TO_TYPE = {
  '4e02cc5b-8fc8-4c79-8013-e7f510c850d5': 'gstr_2b_books',
  '855fe095-84c6-4947-a5e4-a73da83b2fd6': 'gstr_2b_books_multistate',
  'b2d3fad4-0d90-4b49-acdc-d243cfa9c8d5': 'gstr_3b_tally_entry',
  '93d027ac-4333-403b-b448-9c637ebfc13c': 'universal_bank_statement',
  '8b8d0876-3169-4511-96d8-2a7467478007': 'gstr_1_vs_books',
  'b2300af8-26d0-4299-b233-0cd48c2b96ec': 'amazon_mtr_consolidator',
  '974ac4f2-1437-4ccc-826c-c2ea68e5b5e3': 'pdf_bank_extract',
  'dcb5d5e9-9857-4925-b55d-b581bd6dec1e': 'einvoice_reco',
  '6fcb5c0e-7397-495c-af1e-9b1fe5faa2ad': 'myntra_ticket_finder',
  'ebcc3f8c-3e05-4132-860c-70e63b2380f1': 'zepto_receivables',
  '97702640-9642-4278-b34a-d1af684006ce': 'receivable_cycle',
  '290c797b-ec07-4caa-984f-45935e5c6b2a': 'bank_tally_reco',
};

export default function AgentDispatch() {
  const { agentId } = useParams();
  const recoType = RECO_ID_TO_TYPE[agentId];

  if (recoType === 'amazon_mtr_consolidator') return <MtrWorkspace />;
  if (recoType === 'gstr_2b_books_multistate') return <RecoMultiStateWorkspace />;
  if (recoType === 'pdf_bank_extract') return <PdfBankExtractorWorkspace />;
  if (recoType === 'myntra_ticket_finder') return <MyntraTicketFinderWorkspace />;
  if (recoType === 'gstr_3b_tally_entry') return <Gstr3bTallyWorkspace />;
  // key by agentId so switching between two RecoWorkspace-backed agents (e.g. Universal → Bank Reco)
  // remounts a fresh instance — prevents stale result/upload state from bleeding across agents.
  if (recoType) return <RecoWorkspace key={agentId} agentTypeProp={recoType} />;
  return <AgentWorkspace />;
}
