import React , {useState} from 'react'
import Markdown from 'react-markdown'

const CreationItem = ({item}) => {

  const [expanded , setExpanded] = useState(false)

  const getCreationTypeName = () => {
    const typeLabels = {
      image: 'Image',
      article: 'Article',
      'blog-title': 'Blog Title',
      'resume-review': 'Review Resume',
      'remove-background': 'Remove Background',
      'remove-object': 'Remove Object',
    }

    if (item.type && typeLabels[item.type]) {
      return typeLabels[item.type]
    }

    const promptText = String(item.prompt || '').toLowerCase()
    const contentText = String(item.content || '').toLowerCase()

    if (promptText.includes('review the uploaded resume')) return 'Review Resume'
    if (promptText.includes('remove background')) return 'Remove Background'
    if (promptText.includes('remove ') && promptText.includes(' from image')) return 'Remove Object'
    if (promptText.includes('generate an image')) return 'Image'
    if (contentText.includes('overall assessment') || contentText.includes('ats optimization')) return 'Review Resume'

    return 'Creation'
  }

  return (
    <div onClick={()=> setExpanded(!expanded)} className='p-4 max-w-5xl text-sm bg-white border border-gray-200 rounded-lg cursor-pointer'>
      <div className='flex justify-between items-center gap-4'>
         <div>
          <h2>{item.prompt}</h2>
          <p className='text-grey-500'>{item.type} - {new Date(item.created_at).toLocaleDateString()}</p>
         </div>
         <button className='bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E40AF] px-4 py-1 rounded-full whitespace-nowrap'>
          {getCreationTypeName()}
         </button>
      </div>
      {
        expanded &&(
          <div>
            {item.type === 'image'?(
              <div>
                <img src={item.content} alt="image" className='mt-3 w-full max-w-md' />
              </div>
            ):(
              <div className='mt-3 h-full overflow-y-scroll text-sm text-slate-700'>
                <div className='reset-tw'>
                  <Markdown>
                    {item.content}
                  </Markdown>
                </div>
              </div>
            )}
          </div>
        )
      }
    </div>
  )
}

export default CreationItem
