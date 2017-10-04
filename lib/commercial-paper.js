/** Transaction logic **/

/**
 * Issues a new commercial paper
 *
 * @param {fabric.ibm.commercialpaper.IssuePaper} issueOrder Contains data to issue a commercial paper
 * @transaction
 */
function issuePaper(issueOrder) {
	var validationErrors = validateIssueOrder(issueOrder);
	if (validationErrors.length > 0) {
		throw new Error(validationErrors.toString());
	}
  
	// Build the asset and add it to the ledger
	return getAssetRegistry('fabric.ibm.commercialpaper.CommercialPaper')
		.then(function(assRegistry) {
      		var assFactory = getFactory();
            var newPaper = assFactory.newResource('fabric.ibm.commercialpaper', 'CommercialPaper', issueOrder.CUSIP)
            newPaper.par = issueOrder.par;
            newPaper.quantityIssued = issueOrder.quantityIssued;
            newPaper.discount = issueOrder.discount;
            newPaper.maturity = issueOrder.maturity;
            newPaper.issuer = issueOrder.issuer;
            newPaper.issuedTimestamp = issueOrder.issuedTimestamp;
      
      		return assRegistry.add(newPaper);
    	})
  		.catch(function(error) {
      		throw new Error(error);
    	});
}

/**
 * Purchases commercial paper and assigns it to the requested issuer
 *
 * @param {fabric.ibm.commercialpaper.PurchasePaper} purchaseOrder Contains info to purchase commercial paper
 * @transaction
 */
function purchasePaper(purchaseOrder) {
  	// Validate the purchase order
  	var validationErrors = validatePurchaseOrder(purchaseOrder);
  	if (validationErrors.length > 0) {
      	throw new Error(validationErrors.toString());
    }
  
  	var totalPapersIssued = purchaseOrder.paper.quantityIssued;	// Total number of papers issued
  	var totalOwned = 0;											// Total number of issued papers owned by participants
  	var totalForSale = 0;										// Total number of issued papers that are for sale
  	var totalNeeded = purchaseOrder.quantity;					// Running total of number of papers still needed - updated during purchase process
  	var unpurchasedPapers = 0;									// Total number of issued papers that have not yet been purchased from the issuer
  	var ownedByCurrentParticipant = null;						// Ownership object if the current participant already owns some of this paper
  	var potentialPurchaseFrom = [];								// Array of ownerships willing to sell some or all their papers
  	var actualPurchaseFrom = [];								// Array of ownerships which have been selected to purchase from
  
  	// Retrieve all ownerships of this paper
  	var ownershipsQuery = buildQuery('SELECT fabric.ibm.commercialpaper.PaperOwnership WHERE (paper == _$paper)');
  
  	return query(ownershipsQuery, { paper: 'resource:' + purchaseOrder.paper.getFullyQualifiedIdentifier() })
  			.then(function(ownerships) {
                // Process each ownership to find available papers and to retrieve paper already owned by this company
                ownerships.forEach(function(ownership) {
                  if (ownership.owner.getFullyQualifiedIdentifier() === getCurrentParticipant().getFullyQualifiedIdentifier()) {
                    ownedByCurrentParticipant = ownership;
                  } else {
                    totalForSale += ownership.quantityForSale;

                    if (ownership.quantityForSale > 0) {
                      potentialPurchaseFrom.push(ownership);
                    }
                  }

                  totalOwned += ownership.quantity;
                });
      
                // Add as available for purchase those papers which have been issued but have not been purchased by anyone yet
                unpurchasedPapers = totalPapersIssued - totalOwned;
                totalForSale += unpurchasedPapers;

                // Ensure there are enough papers available for sale
                if (purchaseOrder.quantity > totalForSale) {
                  throw new Error("Attempting to purchase " + purchaseOrder.quantity + " papers but only " + totalForSale + " are available for purchase");
                }
      
      			// Get the asset registry to begin executing the purchases
      			return getAssetRegistry('fabric.ibm.commercialpaper.PaperOwnership');
    		})
  			.then(function(assRegistry) {
      			var promises = [];			// Array of promises that contain all PaperOwnership updates and are resolved at the end
      
                // First get unpurchased papers
                if (unpurchasedPapers >= totalNeeded) {
                    unpurchasedPapers -= totalNeeded;
                  	actualPurchaseFrom.push({ "company": purchaseOrder.paper.issuer.name, "amount": totalNeeded });
                    totalNeeded = 0;
                } else {
                    totalNeeded -= unpurchasedPapers;
                  	actualPurchaseFrom.push({ "company": purchaseOrder.paper.issuer.name, "amount": unpurchasedPapers });
                    unpurchasedPapers = 0;
                }
      
      			// Purchase any remaining needed paper from other sellers
      			while (totalNeeded > 0) {
                    var seller = potentialPurchaseFrom.shift();

                    if (totalNeeded <= seller.quantityForSale) {
                        seller.quantity -= totalNeeded;
                        seller.quantityForSale -= totalNeeded;
                      
                      	actualPurchaseFrom.push({ "company": seller.owner.getIdentifier(), "amount": totalNeeded });
                        totalNeeded = 0;

                      	if (seller.quantity > 0) {
                        	promises.push(assRegistry.update(seller));
                        } else {
                          	promises.push(assRegistry.remove(seller));
                        }
                    } else {
                        totalNeeded -= seller.quantityForSale;
                        seller.quantity -= seller.quantityForSale;
                      
                      	actualPurchaseFrom.push({ "company": seller.owner.getIdentifier(), "amount": seller.quantityForSale });
                        seller.quantityForSale = 0;
                      
                      	if (seller.quantity > 0) {
                        	promises.push(assRegistry.update(seller));
                        } else {
                          	promises.push(assRegistry.remove(seller));
                        }
                    }
                }
      
      			promises.push(getParticipantRegistry('fabric.ibm.commercialpaper.Company')
                            	.then(function(partRegistry) {
                  					var participantPromises = [];
                  
                  					actualPurchaseFrom.forEach(function(seller) {
                                		participantPromises.push(partRegistry.get(seller.company)
                                                            	.then(function(participant) {
                                          							var cost = costOfPurchase(seller.amount, purchaseOrder.paper.par, purchaseOrder.paper.discount);
                                      								participant.balance += cost;
                                      								return partRegistry.update(participant);
                                    							}));
                                	});
                  					
                  					purchaseOrder.buyer.balance -= costOfPurchase(purchaseOrder.quantity, purchaseOrder.paper.par, purchaseOrder.paper.discount);;
                  					participantPromises.push(partRegistry.update(purchaseOrder.buyer));
                                    return Promise.all(participantPromises);
                                }));
      
                if (totalNeeded <= 0) {
                    if (ownedByCurrentParticipant != null) {
                        ownedByCurrentParticipant.quantity += purchaseOrder.quantity;
                        ownedByCurrentParticipant.quantityForSale += purchaseOrder.quantityForSale;

                        promises.push(assRegistry.update(ownedByCurrentParticipant));
                    } else {
                        var factory = getFactory();
                        var newOwnershipID = purchaseOrder.buyer.getFullyQualifiedIdentifier() + ',' + purchaseOrder.paper.CUSIP;
                        var newOwnership = factory.newResource('fabric.ibm.commercialpaper', 'PaperOwnership', newOwnershipID);
                        newOwnership.paper = purchaseOrder.paper;
                        newOwnership.owner = purchaseOrder.buyer;
                        newOwnership.quantity = purchaseOrder.quantity;
                        newOwnership.quantityForSale = purchaseOrder.quantityForSale;

                        promises.push(assRegistry.add(newOwnership));
                    }
                } else {
                  	throw new Error("Could not find enough papers to purchase, cancelling transaction");
                }
      
      			return Promise.all(promises);
    		})
  			.catch(function(error) {
      			throw new Error(error);
    		});
}

/** Helper functions **/

/**
 * Checks the contents of the request when a participant attempts
 * to purchase commercial paper and verifies that the contents pass
 * sanity checks
 *
 * @param {fabric.ibm.commercialpaper.PurchasePaper} purchaseOrder The object containing the purchase details
 * @return {array} An array of error messages, empty if there are none
 */
function validatePurchaseOrder(purchaseOrder) {
  	var errors = [];
  
  	var ownerErr = validateParticipantIsCurrentParticipant(purchaseOrder.buyer);
  	if (ownerErr.error) {
      	errors.push(ownerErr.msg);
    }
  
  	var quantErr = validateQuantityPurchased(purchaseOrder.quantity);
  	if (quantErr.error) {
      	errors.push(quantErr.msg);
    }
  
  	var quantForSaleErr = validateQuantityForSale(purchaseOrder.quantity, purchaseOrder.quantityForSale);
  	if (quantForSaleErr.error) {
      	errors.push(quantForSaleErr.msg);
    }
  
  	var balanceErr = validateBalance(purchaseOrder.buyer, purchaseOrder.quantity, purchaseOrder.paper);
  	if (balanceErr.error) {
      	errors.push(balanceErr.msg);
    }
  
  	return errors;
}

/**
 * Checks the contents of the request when a participant attempts
 * to issue commercial paper and verifies that the contents pass
 * sanity checks
 *
 * @param {fabric.ibm.commercialpaper.IssuePaper} issueOrder The object containing the paper issue details
 * @return {array} An array of error messages, empty if there are none
 */
function validateIssueOrder(issueOrder) {
	var errors = [];

	var cusipErr = validateCUSIP(issueOrder.CUSIP);
	if (cusipErr.error) {
		errors.push(cusipErr.msg);
    }
  
   	var parErr = validatePar(issueOrder.par);
  	if (parErr.error) {
      	errors.push(parErr.msg);
    }
  
   	var quantErr = validateQuantityIssued(issueOrder.quantityIssued);
  	if (quantErr.error) {
      	errors.push(quantErr.msg);
    }
  
   	var discountErr = validateDiscount(issueOrder.discount);
  	if (discountErr.error) {
      	errors.push(discountErr.msg);
    }
  
   	var maturityErr = validateMaturity(issueOrder.maturity);
  	if (maturityErr.error) {
      	errors.push(maturityErr.msg);
    }
  
 	var issuerErr = validateParticipantIsCurrentParticipant(issueOrder.issuer);
  	if (issuerErr.error) {
      	errors.push(issuerErr.msg);
    }
	
	return errors;
}

function validateCUSIP(cusip) {
	if (cusip.length != 9) {
		return { "error": true, "msg": "CUSIP must be 9 characters long" };
	}

	return { "error": false };
}

function validatePar(par) {
  	if (par <= 0) {
      	return { "error": true, "msg": "Par value must be greater than 0" };
    }
  
  	return { "error": false };
}

function validateQuantityIssued(quantIssued) {
  	if (quantIssued <= 0) {
      	return { "error": true, "msg": "Quantity issued must be greater than 0" };
    }
  
  	return { "error": false };
}

function validateDiscount(discount) {
  	if (!(discount > 0 && discount < 1)) {
      	return { "error": true, "msg": "Discount must be greater than 0% and less than 100%" };
    }
  
  	return { "error": false };
}

function validateMaturity(maturity) {
  	if (!(maturity > 0 && maturity <= 270)) {
      	return { "error": true, "msg": "Maturity must be at least 1 day and less than 270 days" };
    }
  
  	return { "error": false };
}

function validateParticipantIsCurrentParticipant(participant) {
  	if (getCurrentParticipant() == null) {
      	return { "error": true, "msg": "Identity is not associated with any participant, cannot issue commercial paper" };
    }
  
  	if (!(participant.getFullyQualifiedIdentifier() === getCurrentParticipant().getFullyQualifiedIdentifier())) {
      	return { "error": true, "msg": "A participant can only issue or purchase commercial paper for itself" };
    }
  
  	return { "error": false };
}

function validateQuantityPurchased(quantPurchased) {
  	return { "error": false };
}

function validateQuantityForSale(quantPurchased, quantForSale) {
  	if (quantForSale > quantPurchased) {
      	return { "error": true, "msg": "Quantity for sale must be less than or equal to the quantity purchased" };
    }
  
  	return { "error": false };
}

function validateBalance(buyer, amount, paper) {
  	var cost = costOfPurchase(amount, paper.par, paper.discount);
  	if (cost > buyer.balance) {
      	return { "error": true, "msg": "Buyer does not have sufficient funds to purchase paper, balance = $" + buyer.balance + ", cost = $" + cost };
    }
  
  	return { "error": false };
}

function costOfPurchase(amount, par, discount) {
  	return amount * (par * (1 - discount));
}
