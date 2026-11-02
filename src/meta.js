export const meta = {
  name: 'BB 课件批量下载',
  namespace: 'bb-bulk-course-downloader',
  description: '扫描 Blackboard 课程内容，勾选后按原始目录结构批量下载课件',
  matches: [
    'https://*/webapps/blackboard/content/listContent.jsp*',
    'http://*/webapps/blackboard/content/listContent.jsp*'
  ],
  grant: 'none',
  runAt: 'document-idle'
};
