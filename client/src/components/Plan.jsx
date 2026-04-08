import React from 'react'
import {PricingTable} from '@clerk/clerk-react'

const Plan = () => {
  return (
    <div className = 'max-w-2xl mx-auto z-20 my-30'>
      <div className='text-center'>
        <h2 className='text-scale-700 text-[42px] font-semibold'>Choose your plan</h2>
        <p className='text-grey-500 m-w-lg mx-auto'>Start for free and scale up as you grow. Find the perfect plan for your content creation needs.</p>
      </div>

      <div className='mt-14 mr-2 max-sm:mx-8'>
        <PricingTable/>
      </div>
    </div>
  )
}

export default Plan
