import unittest
from test_server import BureauTests

class AgentMemoryTests(BureauTests):
    def test_external_schedule_metadata_cannot_enable_local_execution(self):
        value={'owner':'chatgpt','localEnabled':False,'flows':[{'id':'orders'},{'id':'replies'}]}
        self.request('/api/agent/schedules',value)
        self.app.initialize()
        self.assertEqual(__import__('json').loads(self.request('/api/state')['agent_schedule']),value)
        with self.assertRaises(Exception):
            self.request('/api/agent/schedules',{**value,'localEnabled':True})

    def test_one_request_one_canonical_message_and_task_binding(self):
        first=self.request('/api/agent/inbox', {'requestKey':'request-1','content':'Проверь инструменты','quality':'high'})
        second=self.request('/api/agent/inbox', {'requestKey':'request-1','content':'Проверь инструменты','quality':'high'})
        self.assertEqual(first['user_message_id'],second['user_message_id'])
        self.assertEqual(len(self.request('/api/state')['messages']),1)
        self.request('/api/agent/bind', {'requestKey':'request-1','taskId':'t-controlled'})
        state=self.request('/api/state')
        self.assertEqual(state['agent_work'][0]['task_id'],'t-controlled')
        self.app.initialize()
        self.assertEqual(self.request('/api/state')['agent_work'][0]['task_id'],'t-controlled')

    def test_review_updates_same_assistant_message_without_erasing_history(self):
        self.request('/api/message', {'content':'Existing history'})
        self.request('/api/agent/inbox', {'requestKey':'request-2','content':'Safe task'})
        self.request('/api/agent/bind', {'requestKey':'request-2','taskId':'t-controlled'})
        task={'id':'t-controlled','state':'queued','reason':'Queued','attempts':[]}
        self.request('/api/agent/update', {'task':task})
        task.update(state='verified',reason='Independently checked',result={'summary':'Observed result'},reviews=[{'decision':'accept','criteria':[{'criterionId':'observed','status':'confirmed'}]}])
        self.request('/api/agent/update', {'task':task})
        state=self.request('/api/state')
        self.assertEqual(len(state['messages']),3)
        self.assertEqual(state['messages'][0]['content'],'Existing history')
        self.assertIn('verified',state['messages'][-1]['content'])
        self.assertIn('Observed result',state['messages'][-1]['content'])

if __name__=='__main__': unittest.main()
